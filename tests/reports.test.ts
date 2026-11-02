import test from 'node:test';
import assert from 'node:assert/strict';
import {csvCell,reportInput,retentionSchema} from '../packages/core/src/reports';

test('report CSV neutralizes formulas and preserves quoted/newline content',()=>{
 for(const value of ['=cmd()','+123','-2','@SUM(A1)','\t=cmd()','\r=cmd()','  =cmd()'])assert.ok(csvCell(value).startsWith('"\''));
 assert.equal(csvCell('A,"B"\nC'),'"A,""B""\nC"');
 assert.equal(csvCell(12.5),'"12.5"');assert.equal(csvCell(null),'""');
});
test('report ranges and analytics retention are bounded and never configure media deletion',()=>{
 assert.equal(reportInput.parse({kind:'engagement',from:'2026-10-01T00:00:00Z',to:'2026-10-25T00:00:00Z'}).limit,50);
 assert.throws(()=>reportInput.parse({kind:'content',from:'2026-10-25',to:'2026-10-01'}));
 assert.throws(()=>reportInput.parse({kind:'content',from:'2025-01-01T00:00:00Z',to:'2026-10-01T00:00:00Z'}));
 assert.deepEqual(retentionSchema.parse({rawDays:90,aggregateMonths:13}),{rawDays:90,aggregateMonths:13});
 assert.throws(()=>retentionSchema.parse({rawDays:365,aggregateMonths:1}));
 assert.throws(()=>retentionSchema.parse({rawDays:90,aggregateMonths:13,deleteMedia:true}));
});
