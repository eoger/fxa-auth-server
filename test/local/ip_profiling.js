/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

var sinon = require('sinon')

const assert = require('insist')
var mocks = require('../mocks')
var getRoute = require('../routes_helpers').getRoute
var proxyquire = require('proxyquire')

var P = require('../../lib/promise')
var uuid = require('uuid')
var crypto = require('crypto')
var log = require('../../lib/log')

var TEST_EMAIL = 'foo@gmail.com'
var MS_ONE_DAY = 1000 * 60 * 60 * 24

const makeRoutes = function (options, requireMocks) {
  options = options || {}

  const config = options.config || {}
  config.verifierVersion = config.verifierVersion || 0
  config.smtp = config.smtp || {}
  config.memcached = config.memcached || {
    address: '127.0.0.1:1121',
    idle: 500,
    lifetime: 30
  }
  config.i18n = {
    supportedLanguages: ['en'],
    defaultLanguage: 'en'
  }
  config.lastAccessTimeUpdates = {}
  config.signinConfirmation = config.signinConfirmation || {}
  config.signinUnblock = config.signinUnblock || {}
  config.push = {
    allowedServerRegex: /^https:\/\/updates\.push\.services\.mozilla\.com(\/.*)?$/
  }

  const log = options.log || mocks.mockLog()
  const Password = options.Password || require('../../lib/crypto/password')(log, config)
  const db = options.db || mocks.mockDB()
  const customs = options.customs || {
    check: () => { return P.resolve(true) }
  }
  const mailer = options.mailer || {}
  const push = options.push || require('../../lib/push')(log, db, {})
  const signinUtils = options.signinUtils || require('../../lib/routes/utils/signin')(log, config, customs, db, mailer)
  if (options.checkPassword) {
    signinUtils.checkPassword = options.checkPassword
  }
  return proxyquire('../../lib/routes/account', requireMocks || {})(
    log,
    db,
    mailer,
    Password,
    config,
    customs,
    signinUtils,
    push,
    options.devices || require('../../lib/devices')(log, db, push)
  )
}

function runTest(route, request, assertions) {
  return new P(function (resolve, reject) {
    route.handler(request, function (response) {
      if (response instanceof Error) {
        reject(response)
      } else {
        resolve(response)
      }
    })
  })
    .then(assertions)
}

var config = {
  securityHistory: {
    ipProfiling: {
      allowedRecency: MS_ONE_DAY
    }
  },
  signinConfirmation: {
    tokenVerificationCode: {
      codeLength: 8
    },
    forcedEmailAddresses: /.+@mozilla\.com$/
  },
  signinUnblock: {},
  secondaryEmail: {
    enabled: false
  }
}
// We want to test what's actually written to stdout by the logger.
const mockLog = log('ERROR', 'test', {
  stdout: {
    on: sinon.spy(),
    write: sinon.spy()
  },
  stderr: {
    on: sinon.spy(),
    write: sinon.spy()
  }
})
const mockRequest = mocks.mockRequest({
  payload: {
    authPW: crypto.randomBytes(32).toString('hex'),
    email: TEST_EMAIL,
    service: 'sync',
    reason: 'signin',
    metricsContext: {
      flowBeginTime: Date.now(),
      flowId: 'F1031DF1031DF1031DF1031DF1031DF1031DF1031DF1031DF1031DF1031DF103'
    }
  },
  query: {
    keys: 'true'
  }
})
var keyFetchTokenId = crypto.randomBytes(16)
var sessionTokenId = crypto.randomBytes(16)
var uid = uuid.v4('binary').toString('hex')
var mockDB = mocks.mockDB({
  email: TEST_EMAIL,
  emailVerified: true,
  keyFetchTokenId: keyFetchTokenId,
  sessionTokenId: sessionTokenId,
  uid: uid
})
var mockMailer = mocks.mockMailer()
var mockPush = mocks.mockPush()
var mockCustoms = {
  check: () => P.resolve(),
  flag: () => P.resolve()
}

mockDB.accountRecord = function () {
  return P.resolve({
    authSalt: crypto.randomBytes(32),
    data: crypto.randomBytes(32),
    email: TEST_EMAIL,
    emailVerified: true,
    primaryEmail: {normalizedEmail: TEST_EMAIL, email: TEST_EMAIL, isVerified: true, isPrimary: true},
    kA: crypto.randomBytes(32),
    lastAuthAt: function () {
      return Date.now()
    },
    uid: uid,
    wrapWrapKb: crypto.randomBytes(32)
  })
}

describe('IP Profiling', () => {

  var route, accountRoutes

  beforeEach(() => {
    accountRoutes = makeRoutes({
      checkPassword: function () {
        return P.resolve(true)
      },
      config: config,
      customs: mockCustoms,
      db: mockDB,
      log: mockLog,
      mailer: mockMailer,
      push: mockPush
    })
    route = getRoute(accountRoutes, '/account/login')
  })

  it(
    'no previously verified session',
    () => {
      mockDB.securityEvents = function () {
        return P.resolve([
          {
            name: 'account.login',
            createdAt: Date.now(),
            verified: false
          }
        ])
      }

      return runTest(route, mockRequest, function (response) {
        assert.equal(mockMailer.sendVerifyLoginEmail.callCount, 1, 'mailer.sendVerifyLoginEmail was called')
        assert.equal(mockMailer.sendNewDeviceLoginNotification.callCount, 0, 'mailer.sendNewDeviceLoginNotification was not called')
        assert.equal(response.verified, false, 'session not verified')
      })
    })

  it(
    'previously verified session',
    () => {
      mockDB.securityEvents = function () {
        return P.resolve([
          {
            name: 'account.login',
            createdAt: Date.now(),
            verified: true
          }
        ])
      }

      return runTest(route, mockRequest, function (response) {
        assert.equal(mockMailer.sendVerifyLoginEmail.callCount, 0, 'mailer.sendVerifyLoginEmail was not called')
        assert.equal(mockMailer.sendNewDeviceLoginNotification.callCount, 1, 'mailer.sendNewDeviceLoginNotification was called')
        assert.equal(response.verified, true, 'session verified')
      })
    })

  it(
    'previously verified session more than a day',
    () => {

      mockDB.securityEvents = function () {
        return P.resolve([
          {
            name: 'account.login',
            createdAt: (Date.now() - MS_ONE_DAY * 2), // Created two days ago
            verified: true
          }
        ])
      }

      return runTest(route, mockRequest, function (response) {
        assert.equal(mockMailer.sendVerifyLoginEmail.callCount, 1, 'mailer.sendVerifyLoginEmail was called')
        assert.equal(mockMailer.sendNewDeviceLoginNotification.callCount, 0, 'mailer.sendNewDeviceLoginNotification was not called')
        assert.equal(response.verified, false, 'session verified')
      })
    })

  it(
    'previously verified session with forced sign-in confirmation',
    () => {
      var forceSigninEmail = 'forcedemail@mozilla.com'
      mockRequest.payload.email = forceSigninEmail

      var mockDB = mocks.mockDB({
        email: forceSigninEmail,
        emailVerified: true,
        keyFetchTokenId: keyFetchTokenId,
        sessionTokenId: sessionTokenId,
        uid: uid
      })

      mockDB.accountRecord = function () {
        return P.resolve({
          authSalt: crypto.randomBytes(32),
          data: crypto.randomBytes(32),
          email: forceSigninEmail,
          emailVerified: true,
          primaryEmail: {normalizedEmail: forceSigninEmail, email: forceSigninEmail, isVerified: true, isPrimary: true},
          kA: crypto.randomBytes(32),
          lastAuthAt: function () {
            return Date.now()
          },
          uid: uid,
          wrapWrapKb: crypto.randomBytes(32)
        })
      }

      mockDB.securityEvents = function () {
        return P.resolve([
          {
            name: 'account.login',
            createdAt: Date.now(),
            verified: true
          }
        ])
      }

      var accountRoutes = makeRoutes({
        checkPassword: function () {
          return P.resolve(true)
        },
        config: config,
        customs: mockCustoms,
        db: mockDB,
        log: mockLog,
        mailer: mockMailer,
        push: mockPush
      })

      route = getRoute(accountRoutes, '/account/login')

      return runTest(route, mockRequest, function (response) {
        assert.equal(mockMailer.sendVerifyLoginEmail.callCount, 1, 'mailer.sendVerifyLoginEmail was called')
        assert.equal(mockMailer.sendNewDeviceLoginNotification.callCount, 0, 'mailer.sendNewDeviceLoginNotification was not called')
        assert.equal(response.verified, false, 'session verified')
        return runTest(route, mockRequest)
      })
        .then(function (response) {
          assert.equal(mockMailer.sendVerifyLoginEmail.callCount, 2, 'mailer.sendVerifyLoginEmail was called')
          assert.equal(mockMailer.sendNewDeviceLoginNotification.callCount, 0, 'mailer.sendNewDeviceLoginNotification was not called')
          assert.equal(response.verified, false, 'session verified')
        })
    })

  it(
    'previously verified session with suspicious request',
    () => {
      mockRequest.payload.email = TEST_EMAIL

      var mockDB = mocks.mockDB({
        email: TEST_EMAIL,
        emailVerified: true,
        keyFetchTokenId: keyFetchTokenId,
        sessionTokenId: sessionTokenId,
        uid: uid
      })

      mockDB.accountRecord = function () {
        return P.resolve({
          authSalt: crypto.randomBytes(32),
          data: crypto.randomBytes(32),
          email: TEST_EMAIL,
          emailVerified: true,
          primaryEmail: {normalizedEmail: TEST_EMAIL, email: TEST_EMAIL, isVerified: true, isPrimary: true},
          kA: crypto.randomBytes(32),
          lastAuthAt: function () {
            return Date.now()
          },
          uid: uid,
          wrapWrapKb: crypto.randomBytes(32)
        })
      }

      mockDB.securityEvents = function () {
        return P.resolve([
          {
            name: 'account.login',
            createdAt: Date.now(),
            verified: true
          }
        ])
      }

      var accountRoutes = makeRoutes({
        checkPassword: function () {
          return P.resolve(true)
        },
        config: config,
        customs: mockCustoms,
        db: mockDB,
        log: mockLog,
        mailer: mockMailer,
        push: mockPush
      })

      mockRequest.app.clientAddress = '63.245.221.32'
      mockRequest.app.isSuspiciousRequest = true

      route = getRoute(accountRoutes, '/account/login')

      return runTest(route, mockRequest, function (response) {
        assert.equal(mockMailer.sendVerifyLoginEmail.callCount, 1, 'mailer.sendVerifyLoginEmail was called')
        assert.equal(mockMailer.sendNewDeviceLoginNotification.callCount, 0, 'mailer.sendNewDeviceLoginNotification was not called')
        assert.equal(response.verified, false, 'session verified')
        return runTest(route, mockRequest)
      })
        .then(function (response) {
          assert.equal(mockMailer.sendVerifyLoginEmail.callCount, 2, 'mailer.sendVerifyLoginEmail was called')
          assert.equal(mockMailer.sendNewDeviceLoginNotification.callCount, 0, 'mailer.sendNewDeviceLoginNotification was not called')
          assert.equal(response.verified, false, 'session verified')
        })
    })

  afterEach(() => {
    mockMailer.sendVerifyLoginEmail.reset()
    mockMailer.sendNewDeviceLoginNotification.reset()
  })
})
