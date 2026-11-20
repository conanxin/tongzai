import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Node 24 loads the same TypeScript module as the browser build.
import { connectionPathFromStats, probeIceServers } from '../lib/voice-diagnostics.ts';
import type { VoiceConfig } from '../lib/model';

const config: VoiceConfig = {
  provider: 'p2p', livekitConfigured: false, relayConfigured: true,
  iceServers: [{ urls: 'turn:relay.example.com:3478', username: 'private-user', credential: 'private-password' }],
};
class FakePeer {
  onicecandidate: ((event: { candidate: { type: string | null; candidate: string } | null }) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  onicecandidateerror: ((event: { errorCode: number; url?: string; errorText?: string }) => void) | null = null;
  iceGatheringState = 'new';
  closed = false;
  channelCreated = false;
  describe: (() => void) | null = null;
  createDataChannel() { this.channelCreated = true; }
  async createOffer() { return { type: 'offer', sdp: 'private-sdp' }; }
  async setLocalDescription() { this.describe?.(); }
  close() { this.closed = true; }
}
function fakeFactory(peer: FakePeer) {
  return (configuration: RTCConfiguration) => {
    assert.equal(configuration.iceTransportPolicy, 'all');
    assert.equal(configuration.iceCandidatePoolSize, 0);
    return peer as unknown as RTCPeerConnection;
  };
}

test('network probe counts gathered candidates without retaining addresses, credentials or raw errors', async () => {
  const peer = new FakePeer();
  peer.describe = () => {
    peer.onicecandidate?.({ candidate: { type: 'host', candidate: 'candidate:1 1 udp 1 192.168.1.5 12345 typ host' } });
    peer.onicecandidate?.({ candidate: { type: null, candidate: 'candidate:2 1 udp 1 198.51.100.2 23456 typ relay' } });
    peer.onicecandidateerror?.({ errorCode: 701, url: 'turn:private-user@relay.example.com', errorText: 'private-password' });
    peer.onicecandidateerror?.({ errorCode: 701 });
    peer.onicecandidate?.({ candidate: null });
  };
  const result = await probeIceServers(config, { createPeer: fakeFactory(peer), timeoutMs: 100 });
  assert.deepEqual(result, { candidates: { host: 1, srflx: 0, relay: 1 }, iceErrors: [701], completed: true });
  assert.equal(peer.channelCreated, true);
  assert.equal(peer.closed, true);
  assert.equal(peer.onicecandidate, null);
  assert.doesNotMatch(JSON.stringify(result), /private|192\.168|198\.51|example\.com|sdp/);
});

test('timeout returns an unconfirmed probe and closes resources', async () => {
  const peer = new FakePeer();
  const result = await probeIceServers(config, { createPeer: fakeFactory(peer), timeoutMs: 15 });
  assert.equal(result.completed, false);
  assert.equal(result.candidates.relay, 0);
  assert.equal(peer.closed, true);
});

test('cancelling a pending probe closes immediately; pre-cancelled probes create no peer', async () => {
  const controller = new AbortController();
  const peer = new FakePeer();
  const checking = probeIceServers(config, { createPeer: fakeFactory(peer), signal: controller.signal });
  controller.abort();
  await assert.rejects(checking, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(peer.closed, true);
  assert.equal(peer.onicecandidateerror, null);
  await assert.rejects(probeIceServers(config, {
    signal: controller.signal,
    createPeer: () => { throw new Error('must not construct a peer'); },
  }), (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
});

test('offer failures close the probe and reject without waiting for its deadline', async () => {
  const peer = new FakePeer();
  peer.createOffer = async () => { throw new Error('offer unavailable'); };
  await assert.rejects(probeIceServers(config, { createPeer: fakeFactory(peer) }), /offer unavailable/);
  assert.equal(peer.closed, true);
});

test('actual connection path follows transport-selected pair, ignoring other successful relay pairs', () => {
  const records = new Map<string, Record<string, unknown>>([
    ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
    ['selected', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { type: 'local-candidate', candidateType: 'srflx' }],
    ['remote', { type: 'remote-candidate', candidateType: 'host' }],
    ['old-pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'relay' }],
    ['relay', { type: 'local-candidate', candidateType: 'relay' }],
  ]);
  const stats = records as unknown as RTCStatsReport;
  assert.equal(connectionPathFromStats(stats), 'direct');
  records.get('remote')!.candidateType = 'relay';
  assert.equal(connectionPathFromStats(stats), 'relay');
  records.delete('transport');
  assert.equal(connectionPathFromStats(stats), null);
  records.set('transport', { type: 'transport', selectedCandidatePairId: 'selected' });
  records.get('selected')!.state = 'in-progress';
  assert.equal(connectionPathFromStats(stats), null);
});
