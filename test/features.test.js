// -----------------------------------------------------------------------------
// Every feature the integration can publish satisfies the Gladys model
// (numeric min and max, booleans, category, type, unit, supported_options):
// the real Gladys answers HTTP 422 otherwise, the SDK's fake Gladys does not.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CURRENT } from '../src/constants.js';
import { ROLES, buildDevice } from '../src/devices.js';
import { assertCoreDevice } from './helpers/coreFeature.js';

test('every feature, for every ceiling and language, has a numeric min and max and the core fields', () => {
  const gladys = createFakeGladys({ selector: 'alfen' });
  const chargers = [
    { serial: 'ace0123456', model: 'Eve Single Pro-line', modelId: 'NG910', firmware: '6.4.0' },
    { serial: 'ace0654321' },
  ];
  let devices = 0;
  for (const charger of chargers) {
    for (const language of ['en', 'fr']) {
      for (let ceiling = CURRENT.min; ceiling <= 40; ceiling += 1) {
        const device = buildDevice(gladys, charger, { ceiling, language });
        assert.equal(
          assertCoreDevice(device, `${charger.serial}/${language}/${ceiling} A`),
          ROLES.length,
        );
        devices += 1;
      }
    }
  }
  assert.equal(devices, 2 * 2 * (40 - CURRENT.min + 1));
});
