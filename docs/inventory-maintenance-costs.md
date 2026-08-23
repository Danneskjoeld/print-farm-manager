# Inventory, maintenance and cost accounting

## Filament inventory

Each physical spool is a `filament_rolls` record with initial and remaining net filament weight, purchase price, minimum stock and storage metadata. A roll can be loaded into one printer slot through `printer_filament_slots`; Bambu printers expose slots 0–15 in the UI.

When a tracked job finishes, `production-accounting.js` reads `gcodes.material_grams` and deducts it from the roll assigned to the job's AMS slot (slot 0 for non-AMS jobs). The append-only `filament_transactions` journal prevents duplicate deduction and records manual weight corrections. Material cost is snapshotted on the job from purchase price per initial gram.

## Maintenance

`maintenance_plans` supports day-based intervals, accumulated print-hour intervals, or both. Print hours are derived from job timestamps. Completing a plan creates an immutable `maintenance_records` entry containing time, machine hours, notes, operator and cost, then advances the plan baseline.

## Costs

Each printer has an hourly machine rate and average power draw. Electricity price is stored in `settings.electricity_price_kwh`. On job completion the app snapshots material cost from the assigned roll, machine cost from actual elapsed time and energy cost from elapsed time, configured power and electricity price.

The Costs page aggregates finished jobs by project. Maintenance expenses are shown separately so they remain traceable to their service record.

All new records are included in version 2 JSON backups. Version 1 backups remain restorable with defaults for the new fields.
