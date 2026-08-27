// A scorer that is not a model.
//
// The point of the risk scorer's contract is that nothing downstream of it
// trusts what it says — so the tests need a scorer that can be told to lie,
// crash, or obey an instruction it found in the diff. This is that.
//
// FAKE_SCORER_OUT     file whose contents are written to stdout
// FAKE_SCORER_PROMPT  file to capture the prompt it was given, for inspection
// FAKE_SCORER_FAIL    when set, exit non-zero instead of answering
import fs from 'node:fs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_SCORER_PROMPT) fs.writeFileSync(process.env.FAKE_SCORER_PROMPT, input);
  if (process.env.FAKE_SCORER_FAIL) {
    process.stderr.write('scorer backend unreachable\n');
    process.exit(3);
  }
  process.stdout.write(fs.readFileSync(process.env.FAKE_SCORER_OUT, 'utf8'));
});
