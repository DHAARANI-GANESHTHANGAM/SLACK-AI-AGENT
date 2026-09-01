import http from 'http';
import agent from './index.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); } };

console.log('\n1) parseAnalysisJSON (bug #4 - the fence regex)');
const good = '{"fitScore":88,"insights":["a","b"],"recommendations":["c"]}';
ok('bare JSON', agent.parseAnalysisJSON(good).fitScore === 88);
ok('```json fence', agent.parseAnalysisJSON('```json\n' + good + '\n```').fitScore === 88);
ok('``` fence, no lang', agent.parseAnalysisJSON('```\n' + good + '\n```').fitScore === 88);
ok('prose around JSON', agent.parseAnalysisJSON('Sure! Here you go:\n' + good + '\nHope that helps.').fitScore === 88);
ok('fence + prose', agent.parseAnalysisJSON('Here:\n```json\n' + good + '\n```\nDone.').insights.length === 2);
try { agent.parseAnalysisJSON('total nonsense'); ok('garbage throws', false); }
catch (e) { ok('garbage throws', true); }
// old regex used ''' and literal \n - prove the old one failed on a real fence
const oldWay = ('```json\n' + good + '\n```').replace(/'''json\\n?|\\n?'''/g, '').trim();
let oldBroke = false; try { JSON.parse(oldWay); } catch { oldBroke = true; }
ok('old regex really was broken (regression proof)', oldBroke);

console.log('\n2) shouldSkipUser');
ok('skips bots', agent.shouldSkipUser({id:'B1', name:'buildbot', isBot:true}) === true);
ok('skips Slackbot', agent.shouldSkipUser({id:'USLACKBOT', name:'Slackbot'}) === true);
ok('skips deactivated', agent.shouldSkipUser({id:'U2', name:'Old', isDeleted:true}) === true);
ok('keeps real people', agent.shouldSkipUser({id:'U3', name:'Dhaarani'}) === false);

console.log('\n3) dedupe');
ok('key uses slack id', agent.dedupeKey({id:'U9', name:'A'}) === 'id:U9');
ok('key falls back to name', agent.dedupeKey({name:'Jane Doe'}) === 'name:jane doe');
agent.inFlightMembers.add('id:U9');
const r = await agent.analyzeAndPostMember({id:'U9', name:'Dup'});
ok('second event for same member is skipped', r.skipped === true && r.reason === 'analysis_in_progress', JSON.stringify(r));
ok('in-flight entry not clobbered by the skipped call', agent.inFlightMembers.has('id:U9'));
agent.inFlightMembers.delete('id:U9');
ok('dedupe window read from env', agent.dedupeWindowHours === 720, agent.dedupeWindowHours);

console.log('\n4) /health endpoint (bug #5 - res.join)');
const server = agent.app.listen(0);
await new Promise(r => server.once('listening', r));
const port = server.address().port;
const body = await new Promise((res, rej) => {
  http.get(`http://127.0.0.1:${port}/health`, r => {
    let d=''; r.on('data', c => d+=c); r.on('end', () => res({code:r.statusCode, d}));
  }).on('error', rej);
});
ok('GET /health returns 200', body.code === 200, body.code);
ok('GET /health returns JSON', (() => { try { return JSON.parse(body.d).status === 'healthy'; } catch { return false; } })(), body.d);
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
