/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const P = require('./promise')
const Pool = require('./pool')

const LOG_OP_STORE_FOR_DEVICE = "pushbox.storeForDevice"
const SERVICE_SEND_TAB = "sendtab"
const SEND_TAB_TTL = 30 * 24 * 3600 // 30 days.

module.exports = function (log, config) {
  const pool = new Pool(config.pushboxUrl, { timeout: 1000 })

  return {
    /**
     * Send tab data to a set of devices
     *
     * @see {@link store} and {@link storeForDevice} for parameters descriptions.
     */
    sendTab (uid, deviceIds, data, oAuthToken) {
      return this.store(SERVICE_SEND_TAB, uid, deviceIds, data, SEND_TAB_TTL, oAuthToken)
    },

    /**
     * Store service information for a set of devices
     *
     * @param {String[]} deviceIds
     * @see {@link storeForDevice} for other parameters.
     */
    store (service, uid, deviceIds, data, ttl, oAuthToken) {
      return P.each(deviceIds, (deviceId) => {
        return this.storeForDevice(service, uid, deviceId, data, ttl, oAuthToken)
      })
    },

    /**
     * Store service information for a specific device
     *
     * @param {string} service - At the moment only sendtab is supported
     * @param {String} uid - Firefox Account uid
     * @param {String} deviceId
     * @param {String} data - Base64 string of the payload
     * @param {number} ttl
     * @param {String} oAuthToken - Hex string of the user's Pushbox bearer token
     * @returns {Promise}
     */
    storeForDevice (service, uid, deviceId, data, ttl, oAuthToken) {
      log.trace({
        op: LOG_OP_STORE_FOR_DEVICE,
        uid,
        deviceId,
        service
      })
      // Because of the validation code, endpointAction can only be "sendtab".
      return pool.post(`/v1/store/${service}/${uid}/${deviceId}`, {
        data: data,
        ttl: ttl
      }, { Authorization: `Bearer ${oAuthToken}` }})
    }
  }
}
