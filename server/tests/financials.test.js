const request = require('supertest');
const express = require('express');
const Database = require('better-sqlite3');

let db;
let app;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, status TEXT, sale_price REAL, updated_at INTEGER);
    CREATE TABLE parts (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT);
    CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY, part_id INTEGER, printer_id INTEGER, status TEXT,
      started_at INTEGER, finished_at INTEGER, parts_per_plate INTEGER,
      material_cost REAL, machine_cost REAL, energy_cost REAL, maintenance_cost REAL
    );
    CREATE TABLE maintenance_records (id INTEGER PRIMARY KEY, performed_at INTEGER, cost REAL);
    INSERT INTO printers VALUES (1,'P1S-01');
  `);
  app = express();
  app.use('/api/costs', require('../routes/costs')(db));
});
afterEach(() => db.close());

function seedProject(id, status, price, costs) {
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run(id, `Project ${id}`, status, price, Date.now());
  db.prepare('INSERT INTO parts VALUES (?,?,?)').run(id, id, `Part ${id}`);
  db.prepare(`INSERT INTO jobs VALUES (?,?,1,'finished',?,?,1,?,?,?,?)`)
    .run(id, id, Date.now()-10000, Date.now(), ...costs);
}

test('only completed projects generate revenue and profit', async () => {
  seedProject(1, 'completed', 1000, [100,200,50,0]);
  seedProject(2, 'active', 800, [40,60,20,0]);
  db.prepare('INSERT INTO maintenance_records VALUES (1,?,30)').run(Date.now());
  const response = await request(app).get('/api/costs');
  expect(response.status).toBe(200);
  expect(response.body.totals).toMatchObject({
    revenue:1000, total:500, profit:500,
  });
  expect(response.body.projects.find(p=>p.id===1)).toMatchObject({
    sale_price:1000, revenue:1000, production_cost:350, profit:650,
  });
  expect(response.body.projects.find(p=>p.id===2)).toMatchObject({
    sale_price:800, revenue:0, production_cost:120, profit:-120,
  });
});
