import { solvePowChallengeLocally } from '../vendor/pow.ts';

// Fixture lifted from deepseek-pp/scripts/pow-smoke.mjs, which asserts the same
// digest against the same public/deepseek/sha3_wasm_bg.wasm shipped here.
const FIXTURE = {
  challenge: 'cebab4aa8e50955666f589816c66811144e056a8f41c43a43bd78cedc4b5f4a1',
  salt: '8360f8c9205c96c32b7a',
  expireAt: 1739764288699,
  difficulty: 144000,
  answer: 77906,
};

const answer = await solvePowChallengeLocally({
  algorithm: 'DeepSeekHashV1',
  challenge: FIXTURE.challenge,
  salt: FIXTURE.salt,
  difficulty: FIXTURE.difficulty,
  signature: 'fixture-signature',
  expireAt: FIXTURE.expireAt,
});

if (answer.answer !== FIXTURE.answer) {
  throw new Error(`PoW mismatch: got ${answer.answer}, expected ${FIXTURE.answer}`);
}
if (answer.challenge !== FIXTURE.challenge || answer.salt !== FIXTURE.salt) {
  throw new Error('PoW echo of challenge/salt is wrong');
}
if (answer.signature !== 'fixture-signature') {
  throw new Error('PoW signature passthrough is wrong');
}

console.log(`POW_OK answer=${answer.answer} (wasm loaded from disk, no chrome.runtime)`);
