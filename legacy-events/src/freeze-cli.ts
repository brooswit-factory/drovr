#!/usr/bin/env bun
import { InstanceFreezeStore } from './instance-freeze.js';
const [action,instanceId,...extra] = process.argv.slice(2);
if (!instanceId || extra.length || !['freeze','unfreeze','status'].includes(action ?? '')) {
  console.error('Usage: drovr-instance <freeze|unfreeze|status> <instance-id>'); process.exit(2);
}
try {
  const store = new InstanceFreezeStore();
  const state = action === 'status' ? await store.read(instanceId) : await store.set(instanceId,action === 'freeze');
  console.log(JSON.stringify({...state,...(action==='freeze'?{note:'Freeze persisted. The host stops the instance; this command does not claim process exit.'}:{})}));
} catch(e) { console.error(String(e)); process.exitCode=1; }
