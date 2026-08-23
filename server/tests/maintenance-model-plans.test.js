const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

let db;
let app;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE printer_models (model_id TEXT PRIMARY KEY, label TEXT, connector TEXT);
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY, name TEXT, model TEXT, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY, printer_id INTEGER, started_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE maintenance_plans (
      id INTEGER PRIMARY KEY, printer_id INTEGER, name TEXT, description TEXT,
      interval_days INTEGER, interval_print_hours REAL, last_completed_at INTEGER,
      last_completed_print_hours REAL DEFAULT 0, is_active INTEGER DEFAULT 1, created_at INTEGER
    );
    CREATE TABLE maintenance_model_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT, name TEXT, description TEXT,
      interval_days INTEGER, interval_print_hours REAL, is_active INTEGER DEFAULT 1, created_at INTEGER
    );
    CREATE TABLE maintenance_model_states (
      model_plan_id INTEGER, printer_id INTEGER, last_completed_at INTEGER,
      last_completed_print_hours REAL DEFAULT 0, PRIMARY KEY (model_plan_id, printer_id)
    );
    CREATE TABLE maintenance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER, plan_id INTEGER,
      model_plan_id INTEGER, performed_at INTEGER, print_hours REAL DEFAULT 0,
      cost REAL DEFAULT 0, notes TEXT, performed_by TEXT
    );
    CREATE TABLE printer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER,
      event_type TEXT, note TEXT, created_at INTEGER
    );
  `);
  db.prepare("INSERT INTO printer_models VALUES ('p1s','Bambu Lab P1S','bambu')").run();
  db.prepare("INSERT INTO printer_models VALUES ('x1c','Bambu Lab X1C','bambu')").run();
  db.prepare("INSERT INTO printers VALUES (1,'P1S-01','p1s',1)").run();
  db.prepare("INSERT INTO printers VALUES (2,'P1S-02','p1s',1)").run();
  db.prepare("INSERT INTO printers VALUES (3,'X1C-01','x1c',1)").run();
  app = express();
  app.use(express.json());
  app.use('/api/maintenance', require('../routes/maintenance')(db));
});

afterEach(() => db.close());

test('one model plan is expanded to every active printer of that model', async () => {
  const created = await request(app).post('/api/maintenance').send({
    model_id: 'p1s', name: 'Clean carbon rods', interval_print_hours: 100,
  });
  expect(created.status).toBe(201);
  const plans = await request(app).get('/api/maintenance');
  expect(plans.status).toBe(200);
  expect(plans.body.map(p => p.printer_name)).toEqual(['P1S-01', 'P1S-02']);
  expect(plans.body.every(p => p.plan_scope === 'model')).toBe(true);
});

test('a printer added later automatically receives the model plan', async () => {
  await request(app).post('/api/maintenance').send({ model_id:'p1s', name:'Lubricate', interval_days:30 });
  db.prepare("INSERT INTO printers VALUES (4,'P1S-03','p1s',1)").run();
  const plans = await request(app).get('/api/maintenance');
  expect(plans.body).toHaveLength(3);
});

test('completion advances only the selected machine and writes its log', async () => {
  const created = await request(app).post('/api/maintenance').send({
    model_id:'p1s', name:'Lubricate', interval_print_hours:50,
  });
  const completed = await request(app)
    .post(`/api/maintenance/model/${created.body.id}/complete`)
    .send({ printer_id:1, notes:'Done by Dan', cost:4.5 });
  expect(completed.status).toBe(200);

  const states = db.prepare('SELECT * FROM maintenance_model_states ORDER BY printer_id').all();
  expect(states).toHaveLength(1);
  expect(states[0].printer_id).toBe(1);
  const history = await request(app).get('/api/maintenance/history/all');
  expect(history.body[0]).toMatchObject({
    printer_id:1, printer_name:'P1S-01', plan_name:'Lubricate',
    plan_scope:'model', notes:'Done by Dan', cost:4.5,
  });
  expect(db.prepare('SELECT * FROM printer_events').get()).toMatchObject({
    printer_id:1, event_type:'maintenance',
  });
});

test('completion rejects a printer from a different model', async () => {
  const created = await request(app).post('/api/maintenance').send({ model_id:'p1s', name:'Lubricate' });
  const response = await request(app)
    .post(`/api/maintenance/model/${created.body.id}/complete`).send({ printer_id:3 });
  expect(response.status).toBe(400);
});
