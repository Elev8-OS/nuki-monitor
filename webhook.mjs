#!/usr/bin/env node
/**
 * Registriert einen dezentralen Webhook bei Nuki.
 *
 * Voraussetzung: ein OAuth-Access-Token mit dem Scope "webhook.decentral".
 * Ein reiner API-Token aus Nuki Web reicht dafuer NICHT - siehe README,
 * Abschnitt "Webhooks einrichten".
 *
 * Anzeigen:      node scripts/webhook.mjs list   --token ACCESS_TOKEN
 * Registrieren:  node scripts/webhook.mjs create --token ACCESS_TOKEN --url https://…/api/nuki/webhook
 * Loeschen:      node scripts/webhook.mjs delete --token ACCESS_TOKEN --id 123456789
 */

const BASE_URL = process.env.NUKI_BASE_URL || 'https://api.nuki.io';

// Nur die Features, die dieser Monitor auswertet. Nuki empfiehlt ausdruecklich,
// nicht benoetigte Features abzuschalten, um die Zahl der Webhooks klein zu halten.
const FEATURES = ['DEVICE_STATUS', 'DEVICE_MASTERDATA', 'DEVICE_LOGS'];

function arg(name) {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? null : process.argv[index + 1];
}

async function call(method, path, token, body) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Nuki antwortete mit ${res.status}: ${text.slice(0, 500)}`);
    if (res.status === 401 || res.status === 403) {
      console.error(
        '\nHat der Token wirklich den Scope "webhook.decentral"? Ein API-Token aus Nuki Web reicht hier nicht.'
      );
    }
    process.exit(1);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const command = process.argv[2];
const token = arg('token') || process.env.NUKI_OAUTH_TOKEN;

if (!token) {
  console.error('Kein Token. Nutze --token ACCESS_TOKEN oder setze NUKI_OAUTH_TOKEN.');
  process.exit(1);
}

if (command === 'list') {
  const result = await call('GET', '/api/decentralWebhook', token);
  console.log(JSON.stringify(result, null, 2));
} else if (command === 'create') {
  const webhookUrl = arg('url');
  if (!webhookUrl) {
    console.error('Kein Ziel. Nutze --url https://dein-monitor.up.railway.app/api/nuki/webhook');
    process.exit(1);
  }
  if (!webhookUrl.startsWith('https://')) {
    console.error('Die Webhook-URL muss https sein.');
    process.exit(1);
  }

  const result = await call('PUT', '/api/decentralWebhook', token, {
    webhookUrl,
    webhookFeatures: FEATURES
  });

  console.log('\nWebhook registriert.\n');
  console.log(JSON.stringify(result, null, 2));
  console.log('\n--------------------------------------------------------------');
  console.log('Trage diesen Wert in Railway als NUKI_WEBHOOK_SECRET ein:\n');
  console.log('   ' + (result.secret || '(kein secret in der Antwort)'));
  console.log('\nOhne ihn weist der Monitor jeden Webhook als unsigniert ab.');
  console.log('Die id brauchst du nur zum spaeteren Loeschen: ' + (result.id ?? '?'));
  console.log('--------------------------------------------------------------\n');
} else if (command === 'delete') {
  const id = arg('id');
  if (!id) {
    console.error('Keine id. Nutze --id 123456789, die id findest du ueber "list".');
    process.exit(1);
  }
  await call('DELETE', `/api/decentralWebhook/${id}`, token);
  console.log(`Webhook ${id} geloescht.`);
} else {
  console.error('Unbekannter Befehl. Erlaubt sind: list, create, delete');
  process.exit(1);
}
