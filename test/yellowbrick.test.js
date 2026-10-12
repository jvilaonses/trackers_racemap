const test = require('node:test');
const assert = require('node:assert');
const { decodePositions, normaliseSetup, normaliseLeaderboard } = require('../web/yellowbrick.js');

// Builds a *Positions3 buffer with DTF (flag 2): one team, one absolute and one delta position.
function sampleBuffer() {
  const buf = Buffer.alloc(5 + 4 + 16 + 8);
  let o = 0;
  buf.writeUInt8(2, o); o += 1;                 // flags: DTF
  buf.writeUInt32BE(1700000000, o); o += 4;     // reference time
  buf.writeUInt16BE(7, o); o += 2;              // team id
  buf.writeUInt16BE(2, o); o += 2;              // 2 positions
  // newest, absolute
  buf.writeUInt32BE(3600, o); o += 4;
  buf.writeInt32BE(3589894, o); o += 4;
  buf.writeInt32BE(1451850, o); o += 4;
  buf.writeInt32BE(10000, o); o += 4;
  // older, delta: 600 s earlier
  buf.writeUInt16BE(0x8000 | 600, o); o += 2;
  buf.writeInt16BE(-20, o); o += 2;
  buf.writeInt16BE(30, o); o += 2;
  buf.writeInt16BE(1500, o); o += 2;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

test('decodePositions reads absolute and delta positions, oldest first', () => {
  const result = decodePositions(sampleBuffer());
  assert.deepStrictEqual(Object.keys(result), ['7']);
  const [older, newer] = result[7];
  assert.deepStrictEqual(newer, { at: 1700003600, lat: 35.89894, lon: 14.5185, dtf: 10000 });
  assert.strictEqual(older.at, 1700003000);
  assert.ok(Math.abs(older.lat - 35.89874) < 1e-9);
  assert.ok(Math.abs(older.lon - 14.5188) < 1e-9);
  assert.strictEqual(older.dtf, 11500);
});

test('decodePositions handles a race with no positions', () => {
  const empty = new Uint8Array([0x00, 0x66, 0x85, 0x1e, 0x00]).buffer;
  assert.deepStrictEqual(decodePositions(empty), {});
});

test('normaliseSetup maps divisions to the team handicap field', () => {
  const ev = normaliseSetup({
    title: 'Test',
    tags: [{ id: 1, name: 'IRC Overall', handicap: 'IRC', sort: 2 }, { id: 2, name: 'Line Honours', handicap: 'LEVEL', sort: 1 }],
    teams: [{ id: 3, name: 'Boat', tcf1: '1.100', tcf2: '1.2', tcf3: '1.000', tags: [1, 2], colour: 'FF0000' }],
    course: { nodes: [{ lat: 1, lon: 2, name: 'Start' }] },
    poi: { lines: [{ name: 'Zone', nodes: '1,2,3,4', polygon: true, colour: '00ff00' }] },
  });
  assert.deepStrictEqual(ev.divisions.map((d) => [d.name, d.tcfField]), [['Line Honours', null], ['IRC Overall', 'tcf1']]);
  assert.strictEqual(ev.teams[0].tcf.tcf1, 1.1);
  assert.strictEqual(ev.teams[0].colour, '#FF0000');
  assert.deepStrictEqual(ev.overlays[0].points, [[1, 2], [3, 4]]);
});

test('normaliseLeaderboard converts DTF to nautical miles', () => {
  const lb = normaliseLeaderboard({ tags: [{ id: 5, type: 'IRC', teams: [{ id: 3, rankR: 2, dtf: 1852, tcf: '1.1', finished: false }] }] });
  assert.strictEqual(lb[5].teams[3].rank, 2);
  assert.strictEqual(lb[5].teams[3].dtf, 1);
});
