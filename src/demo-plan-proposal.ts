import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadEnvFile } from 'node:process';

import type { PlanList, PlanningContext, PlanView } from './domain/plans/plans';
import { createApp } from './infrastructure/http/app';
import { createDatabase, type Database } from './infrastructure/persistence/database';

if (existsSync('.env')) loadEnvFile('.env');

const demoAccount = {
  name: 'SIRIP Plan Proposal Demo',
  email: 'sirip-plan-proposal-demo@demo.invalid',
  phone: '+628000000000',
  password: 'SiripPlanDemo2026!',
};
const mockApiKey = 'sirip-demo-key';
const mockSensorApiKey = 'sirip-demo-sensor-key';
const mockModel = 'sirip-demo-model';

async function removeDemoAccount(database: Database) {
  const user = await database.user.findUnique({ where: { email: demoAccount.email }, select: { id: true, name: true } });
  if (!user) return;
  if (user.name !== demoAccount.name) throw new Error(`Refusing to replace unexpected account ${demoAccount.email}`);
  await database.$transaction(async (transaction) => {
    await transaction.plan.deleteMany({ where: { userId: user.id } });
    await transaction.operationalEvent.deleteMany({ where: { userId: user.id } });
    await transaction.temperatureReading.deleteMany({ where: { sensorSession: { batch: { userId: user.id } } } });
    await transaction.sensorSession.deleteMany({ where: { batch: { userId: user.id } } });
    await transaction.sensor.deleteMany({ where: { userId: user.id } });
    await transaction.batch.deleteMany({ where: { userId: user.id } });
    await transaction.fishingTrip.deleteMany({ where: { userId: user.id } });
    await transaction.coldStorage.deleteMany({ where: { userId: user.id } });
    await transaction.vehicle.deleteMany({ where: { userId: user.id } });
    await transaction.destination.deleteMany({ where: { userId: user.id } });
    await transaction.authSession.deleteMany({ where: { userId: user.id } });
    await transaction.user.delete({ where: { id: user.id } });
  });
}

function mockAiServer() {
  let calls = 0;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${mockApiKey}`);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        model: string;
        stream: boolean;
        response_format: { type: string };
        messages: Array<{ role: string; content: string }>;
      };
      assert.equal(body.model, mockModel);
      assert.equal(body.stream, false);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      const prompt = body.messages.find(({ role }) => role === 'user')?.content ?? '';
      const marker = 'Current plan and operational context:\n';
      const markerIndex = prompt.lastIndexOf(marker);
      assert.notEqual(markerIndex, -1);
      const context = JSON.parse(prompt.slice(markerIndex + marker.length)) as PlanningContext;
      assert.equal(context.batches.length, 1);
      assert.ok(context.batches[0]?.quality);
      assert.equal(context.batches[0]?.telemetry.length, 1);
      assert.equal(context.coldStorages.length, 1);
      assert.equal(context.vehicles.length, 1);
      assert.equal(context.destinations.length, 1);
      const batch = context.batches[0]!;
      const coldStorage = context.coldStorages[0]!;
      const vehicle = context.vehicles[0]!;
      const destination = context.destinations[0]!;
      const base = Date.parse(context.now);
      const scheduledAt = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
      const proposal = {
        reason: 'Store, load, and dispatch the monitored demo batch.',
        steps: [
          { actionType: 'STORE', batchId: batch.id, coldStorageId: coldStorage.id, scheduledAt: scheduledAt(60) },
          { actionType: 'LOAD', batchId: batch.id, vehicleId: vehicle.id, scheduledAt: scheduledAt(120) },
          { actionType: 'DISPATCH', batchId: batch.id, destinationId: destination.id, scheduledAt: scheduledAt(180) },
        ],
      };
      calls += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Mock AI failed' }));
    }
  });
  return { server, calls: () => calls };
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function close(server: Server | null) {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function request<T>(baseUrl: string, path: string, method = 'GET', body?: object, cookie = '', expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(path === '/telemetry' ? { 'x-sensor-api-key': mockSensorApiKey } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as T : null as T;
  assert.equal(response.status, expectedStatus, `${method} ${path} returned ${response.status}: ${text}`);
  return { response, data };
}

async function run() {
  const database = createDatabase();
  const mock = mockAiServer();
  let apiServer: Server | null = null;
  let completed = false;
  let databaseReady = false;
  const environment = new Map(['AI_API_URL', 'AI_API_KEY', 'AI_MODEL', 'COOKIE_SECURE', 'SENSOR_API_KEY'].map((key) => [key, process.env[key]]));

  try {
    await removeDemoAccount(database);
    databaseReady = true;
    const mockPort = await listen(mock.server);
    process.env.AI_API_URL = `http://127.0.0.1:${mockPort}/v1/chat/completions`;
    process.env.AI_API_KEY = mockApiKey;
    process.env.AI_MODEL = mockModel;
    process.env.COOKIE_SECURE = 'false';
    process.env.SENSOR_API_KEY = mockSensorApiKey;
    apiServer = createApp(database).listen(0, '127.0.0.1');
    await once(apiServer, 'listening');
    const baseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}/api`;

    const signup = await request<{ user: { id: string } }>(baseUrl, '/auth/signup', 'POST', demoAccount, '', 201);
    assert.ok(signup.data.user.id);
    const cookie = signup.response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    assert.ok(cookie.startsWith('sirip_session='));

    const coldStorage = (await request<{ id: string }>(baseUrl, '/cold-storages', 'POST', {
      name: 'Demo Cold Room', capacityKg: 1000, availableCapacityKg: 1000, operationalStatus: 'AVAILABLE',
    }, cookie, 201)).data;
    const vehicle = (await request<{ id: string }>(baseUrl, '/vehicles', 'POST', {
      code: 'DEMO-TRUCK', capacityKg: 1000, operationalStatus: 'AVAILABLE', restriction: null, availabilityStart: null, availabilityEnd: null,
    }, cookie, 201)).data;
    const destination = (await request<{ id: string }>(baseUrl, '/destinations', 'POST', {
      name: 'Demo Processor', address: 'Demo receiving dock', travelMinutes: 0, receivingStart: '00:00', receivingEnd: '23:59', status: 'AVAILABLE', notes: null,
    }, cookie, 201)).data;
    const trip = (await request<{ id: string }>(baseUrl, '/fishing-trips', 'POST', {
      code: 'DEMO-TRIP', vesselName: 'KM Demo',
    }, cookie, 201)).data;
    const batch = (await request<{ id: string; code: string }>(baseUrl, '/batches', 'POST', {
      code: 'DEMO-BATCH', fishingTripId: trip.id, weightKg: 100, grade: 'A', receivedAt: new Date(Date.now() - 60_000).toISOString(),
    }, cookie, 201)).data;
    const sensor = (await request<{ id: string }>(baseUrl, '/sensors', 'POST', {
      code: 'DEMO-SENSOR', deviceUid: 'sirip-plan-proposal-demo-device', provisioningStatus: 'PROVISIONED',
    }, cookie, 201)).data;
    await request(baseUrl, `/sensors/${sensor.id}/assignment`, 'POST', { batchCode: batch.code }, cookie);
    const telemetry = { sensorId: 'DEMO-SENSOR', deviceUid: 'sirip-plan-proposal-demo-device', temperature: 2.5, sequenceNumber: 0, measuredAt: new Date().toISOString() };
    await request(baseUrl, '/telemetry', 'POST', telemetry);
    await request(baseUrl, '/telemetry', 'POST', telemetry);
    const readings = (await request<Array<{ temperatureC: number }>>(baseUrl, `/sensors/${sensor.id}/readings`, 'GET', undefined, cookie)).data;
    assert.deepEqual(readings.map(({ temperatureC }) => temperatureC), [2.5]);
    const readiness = (await request<{ ready: boolean; completedSteps: number }>(baseUrl, '/setup-readiness', 'GET', undefined, cookie)).data;
    assert.deepEqual(readiness, { ...readiness, ready: true, completedSteps: 4 });

    const proposal = (await request<PlanView>(baseUrl, '/plans/proposals', 'POST', { batchIds: [batch.id] }, cookie, 201)).data;
    assert.equal(mock.calls(), 1);
    assert.equal(proposal.version, 1);
    assert.equal(proposal.status, 'PROPOSED');
    assert.equal(proposal.previousPlanId, null);
    assert.equal(proposal.completedAt, null);
    assert.deepEqual(proposal.steps.map(({ actionType }) => actionType), ['STORE', 'LOAD', 'DISPATCH']);
    assert.deepEqual(proposal.steps.map(({ resource }) => resource?.id), [coldStorage.id, vehicle.id, destination.id]);
    const plans = (await request<PlanList>(baseUrl, '/plans', 'GET', undefined, cookie)).data;
    assert.deepEqual(plans.activePlans, []);
    assert.deepEqual(plans.proposedPlans.map(({ id }) => id), [proposal.id]);
    assert.deepEqual(plans.history, []);

    completed = true;
    console.log(`Generated proposed Plan V${proposal.version} for ${batch.code}`);
    console.log(`Demo login: ${demoAccount.email} / ${demoAccount.password}`);
    console.log(JSON.stringify(proposal, null, 2));
  } finally {
    await close(apiServer);
    await close(mock.server);
    for (const [key, value] of environment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!completed && databaseReady) await removeDemoAccount(database);
    await database.$disconnect();
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Plan proposal demo failed');
  process.exitCode = 1;
});
