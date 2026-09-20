#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'linesentry-edge-flow.json');
const target = join(here, 'linesentry-edge-flow-aws.json');

/**
 * Directory the certificate files are read from inside the Node-RED container.
 *
 * Overridden with CERT_DIR.
 */
const CERT_DIR = process.env.CERT_DIR ?? '/certs';

/**
 * Rewrites the local flow to publish forwarded windows to AWS IoT Core.
 *
 * Reads the flow unchanged, adds a TLS configuration and a second broker, and
 * repoints only the outbound node at it. The window, smoothing and filter
 * nodes are copied as they are, so the local flow stays the single definition
 * of what the gateway computes. See ./EDGE.md.
 */
function toAwsFlow(flow) {
  const rewritten = structuredClone(flow);

  rewritten.push({
    id: 'ls-iot-tls',
    type: 'tls-config',
    name: 'IoT Core device certificate',
    cert: join(CERT_DIR, 'device.pem.crt'),
    key: join(CERT_DIR, 'private.pem.key'),
    ca: join(CERT_DIR, 'AmazonRootCA1.pem'),
    certname: '',
    keyname: '',
    caname: '',
    servername: '',
    verifyservercert: true,
    alpnprotocol: 'x-amzn-mqtt-ca',
  });

  rewritten.push({
    id: 'ls-iot-broker',
    type: 'mqtt-broker',
    name: 'AWS IoT Core',
    broker: '${IOT_ENDPOINT}',
    port: '8883',
    clientid: '${IOT_CLIENT_ID}',
    autoConnect: true,
    usetls: true,
    tls: 'ls-iot-tls',
    protocolVersion: '4',
    keepalive: '60',
    cleansession: true,
    autoUnsubscribe: true,
    birthTopic: '',
    birthQos: '0',
    birthPayload: '',
    closeTopic: '',
    closeQos: '0',
    closePayload: '',
    willTopic: '',
    willQos: '0',
    willPayload: '',
    userProps: '',
    sessionExpiry: '',
  });

  const out = rewritten.find((node) => node.id === 'ls-mqtt-out');
  if (!out) throw new Error('flow has no ls-mqtt-out node to repoint');
  out.broker = 'ls-iot-broker';
  out.name = 'To AWS IoT Core';

  return rewritten;
}

const flow = JSON.parse(readFileSync(source, 'utf8'));
writeFileSync(target, `${JSON.stringify(toAwsFlow(flow), null, 4)}\n`);
console.log(`wrote ${target}`);
