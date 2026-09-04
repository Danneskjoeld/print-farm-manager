const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY, name TEXT, model TEXT, type TEXT, status TEXT,
      is_held INTEGER, is_active INTEGER, group_name TEXT,
      loaded_material TEXT, loaded_color TEXT, job_time_remaining INTEGER
    );
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, name TEXT, status TEXT, priority INTEGER,
      created_at INTEGER, required_material TEXT, required_color TEXT,
      allowed_groups TEXT
    );
    CREATE TABLE parts (
      id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, target_qty INTEGER,
      completed_qty INTEGER, status TEXT, sort_order INTEGER, created_at INTEGER
    );
    CREATE TABLE gcodes (
      id INTEGER PRIMARY KEY, part_id INTEGER, printer_model TEXT,
      parts_per_plate INTEGER, est_print_secs INTEGER, allowed_groups TEXT,
      required_material TEXT, required_color TEXT
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY, part_id INTEGER, printer_id INTEGER, gcode_id INTEGER,
      parts_per_plate INTEGER, status TEXT, started_at INTEGER
    );
  `);
  app = express();
  app.use('/api/planning', require('../routes/planning')(db));
});

afterEach(() => db.close());

test('distributes remaining plates across compatible printers and predicts finish', async () => {
  const now = Date.now();
  db.prepare("INSERT INTO printers VALUES (1,'X1-1','x1c','bambu','IDLE',0,1,'Farm','PLA','Black',NULL)").run();
  db.prepare("INSERT INTO printers VALUES (2,'X1-2','x1c','bambu','IDLE',0,1,'Farm','PLA','Black',NULL)").run();
  db.prepare("INSERT INTO projects VALUES (1,'Order','active',0,?,NULL,NULL,NULL)").run(now);
  db.prepare("INSERT INTO parts VALUES (1,1,'Part',40,0,'open',0,?)").run(now);
  db.prepare("INSERT INTO gcodes VALUES (1,1,'x1c',10,3600,NULL,NULL,NULL)").run();

  const response = await request(app).get('/api/planning');
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ planned_plates:4, planned_parts:40, printers_available:2 });
  expect(response.body.duration_seconds).toBeGreaterThanOrEqual(7199);
  expect(response.body.duration_seconds).toBeLessThanOrEqual(7201);
  expect(response.body.lanes.map(lane => lane.tasks.length)).toEqual([2,2]);
  expect(response.body.unscheduled).toEqual([]);
});

test('reports demand that has no usable G-code', async () => {
  const now = Date.now();
  db.prepare("INSERT INTO projects VALUES (1,'Order','active',0,?,NULL,NULL,NULL)").run(now);
  db.prepare("INSERT INTO parts VALUES (1,1,'Part',12,2,'open',0,?)").run(now);
  const response = await request(app).get('/api/planning');
  expect(response.status).toBe(200);
  expect(response.body.unscheduled[0]).toMatchObject({ part_id:1, quantity:10, reason:'Missing G-code or print duration' });
});
