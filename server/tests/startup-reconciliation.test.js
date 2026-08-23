jest.mock('../events', () => ({ insert: jest.fn() }));
jest.mock('../notifications', () => ({ add: jest.fn() }));

const EventEmitter = require('events');
const Database = require('better-sqlite3');
const JobScheduler = require('../scheduler');

let db;
let scheduler;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE printers (
      id INTEGER PRIMARY KEY, name TEXT, status TEXT, is_held INTEGER,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY, printer_id INTEGER, status TEXT,
      started_at INTEGER, created_at INTEGER
    );
  `);
  scheduler = new JobScheduler(db, new EventEmitter());
});

afterEach(() => db.close());

test('startup keeps a printing job active and clears a stale hold', () => {
  const originalStart = Date.now() - 45 * 60000;
  db.prepare("INSERT INTO printers VALUES (1,'P1S-01','PRINTING',1,1)").run();
  db.prepare("INSERT INTO jobs VALUES (10,1,'printing',?,?)").run(originalStart, originalStart - 1000);

  expect(scheduler.reconcileActivePrints()).toBe(1);
  expect(db.prepare('SELECT status,started_at FROM jobs WHERE id=10').get())
    .toEqual({ status:'printing', started_at:originalStart });
  expect(db.prepare('SELECT is_held FROM printers WHERE id=1').get().is_held).toBe(0);
});

test('startup recovers uploading row without resetting documented start time', () => {
  const originalCreated = Date.now() - 30 * 60000;
  db.prepare("INSERT INTO printers VALUES (1,'P1S-01','PRINTING',1,1)").run();
  db.prepare("INSERT INTO jobs VALUES (11,1,'uploading',NULL,?)").run(originalCreated);

  scheduler.reconcileActivePrints();
  expect(db.prepare('SELECT status,started_at FROM jobs WHERE id=11').get())
    .toEqual({ status:'printing', started_at:originalCreated });
});

test('startup does not recover a job when the live printer is finished', () => {
  db.prepare("INSERT INTO printers VALUES (1,'P1S-01','FINISHED',1,1)").run();
  db.prepare("INSERT INTO jobs VALUES (12,1,'printing',1000,1000)").run();
  expect(scheduler.reconcileActivePrints()).toBe(0);
  expect(db.prepare('SELECT is_held FROM printers WHERE id=1').get().is_held).toBe(1);
});
