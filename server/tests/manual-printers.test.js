const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY, name TEXT, type TEXT, model TEXT, is_active INTEGER,
      status TEXT, hourly_cost REAL DEFAULT 0, power_watts REAL DEFAULT 0,
      job_name TEXT, job_progress REAL, job_time_remaining INTEGER
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT, status TEXT, priority INTEGER DEFAULT 0,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, target_qty INTEGER,
      completed_qty INTEGER DEFAULT 0, status TEXT, sort_order INTEGER DEFAULT 0,
      updated_at INTEGER
    );
    CREATE TABLE gcodes (id INTEGER PRIMARY KEY, filename TEXT);
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER, printer_id INTEGER,
      gcode_id INTEGER, parts_per_plate INTEGER, status TEXT, started_at INTEGER,
      finished_at INTEGER, created_at INTEGER, material_cost REAL DEFAULT 0,
      machine_cost REAL DEFAULT 0, energy_cost REAL DEFAULT 0
    );
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY, printer_id INTEGER, event_type TEXT, note TEXT, created_at INTEGER
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('electricity_price_kwh','0.30');
    INSERT INTO printers VALUES (1,'Form 4','manual','form-4',1,'IDLE',6,200,NULL,NULL,NULL);
    INSERT INTO printers VALUES (2,'Network printer','prusa','mk4s',1,'IDLE',6,200,NULL,NULL,NULL);
    INSERT INTO projects VALUES (1,'Dental models','active',0,1,1);
    INSERT INTO parts VALUES (1,1,'Upper jaw',2,0,'open',0,1);
  `);
  app = express();
  app.use(express.json());
  app.use('/api/printers/:id/jobs', require('../routes/printer-jobs')(db));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
});

afterEach(() => db.close());

test('manual job can be started only on a manual printer', async () => {
  const payload = { part_id: 1, parts_per_plate: 2, estimated_duration_minutes: 90, material_cost: 4.5 };
  expect((await request(app).post('/api/printers/2/jobs/manual-start').send(payload)).status).toBe(404);
  const res = await request(app).post('/api/printers/1/jobs/manual-start').send(payload);
  expect(res.status).toBe(201);
  expect(res.body.status).toBe('printing');
  expect(db.prepare('SELECT status FROM printers WHERE id=1').get().status).toBe('PRINTING');
  expect((await request(app).post('/api/printers/1/jobs/manual-start').send(payload)).status).toBe(409);
});

test('successful completion books quantity, duration and production costs', async () => {
  await request(app).post('/api/printers/1/jobs/manual-start').send({
    part_id: 1, parts_per_plate: 2, estimated_duration_minutes: 90, material_cost: 4.5,
  });
  const res = await request(app).post('/api/printers/1/jobs/manual-complete').send({
    confirmed_qty: 2, actual_duration_minutes: 120, material_cost: 5,
  });
  if (res.status !== 200) throw new Error(res.body.error);
  expect(res.body.status).toBe('finished');
  expect(res.body.finished_at - res.body.started_at).toBe(7200000);
  expect(res.body.material_cost).toBe(5);
  expect(res.body.machine_cost).toBeCloseTo(12);
  expect(res.body.energy_cost).toBeCloseTo(0.12);
  expect(db.prepare('SELECT completed_qty,status FROM parts WHERE id=1').get()).toEqual({ completed_qty: 2, status: 'closed' });
  expect(db.prepare('SELECT status FROM projects WHERE id=1').get().status).toBe('completed');
  expect(db.prepare('SELECT status FROM printers WHERE id=1').get().status).toBe('IDLE');
});

test('failed manual job records costs without crediting parts', async () => {
  await request(app).post('/api/printers/1/jobs/manual-start').send({
    part_id: 1, parts_per_plate: 1, estimated_duration_minutes: 60, material_cost: 2,
  });
  const res = await request(app).post('/api/printers/1/jobs/manual-fail').send({
    actual_duration_minutes: 30, material_cost: 3, note: 'Layer shift',
  });
  if (res.status !== 200) throw new Error(res.body.error);
  expect(res.body.status).toBe('failed');
  expect(res.body.machine_cost).toBeCloseTo(3);
  expect(db.prepare('SELECT completed_qty FROM parts WHERE id=1').get().completed_qty).toBe(0);
  expect(db.prepare("SELECT note FROM printer_events WHERE event_type='job_failed'").get().note).toMatch(/Layer shift/);
});
