-- Versioned tax rule sets and immutable calculation traces.
--
-- A rule set is an effective-dated JSON document. New rates are a NEW version
-- row — old versions are never mutated, so a purchase order priced last
-- quarter keeps pointing at the exact rules that priced it. The engine that
-- interprets these rules lives in supabase/functions/_shared/core/tax-engine.ts
-- and is unit-tested in both Node and Deno; this schema only stores its inputs
-- and outputs.
--
-- rules jsonb shape (interpreted by the engine, validated there):
-- [
--   { "kind": "vat", "name": "Standard VAT", "rate_bps": 2100, "applies_to": "default" },
--   { "kind": "vat", "name": "Reduced VAT",  "rate_bps": 900,  "applies_to": "categories",
--     "categories": ["Produce", "Dairy"] },
--   { "kind": "withholding", "name": "Vendor withholding", "rate_bps": 200,
--     "threshold_minor": 100000 }
-- ]

create table public.tax_rule_sets (
  id              uuid primary key default gen_random_uuid(),
  restaurant_id   uuid not null references public.restaurants (id) on delete cascade,
  version         int not null,
  name            text not null,
  effective_from  date not null,
  effective_to    date,
  rounding_mode   text not null default 'half_up'
                    check (rounding_mode in ('half_up', 'bankers')),
  rules           jsonb not null,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (restaurant_id, version)
);

-- One row per pricing run, immutable. input/output/trace are the engine's
-- full working: what came in, what went out, and every intermediate step.
create table public.tax_calculations (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null references public.restaurants (id) on delete cascade,
  rule_set_id       uuid not null references public.tax_rule_sets (id),
  rule_set_version  int not null,
  document_type     text not null default 'purchase_order',
  input             jsonb not null,
  output            jsonb not null,
  trace             jsonb not null,
  calculated_at     timestamptz not null default now()
);

create index tax_calculations_restaurant_idx
  on public.tax_calculations (restaurant_id, calculated_at desc);

alter table public.tax_rule_sets    enable row level security;
alter table public.tax_calculations enable row level security;

create policy "tax_rule_sets: member read" on public.tax_rule_sets
  for select using (public.is_member(restaurant_id));
create policy "tax_rule_sets: manager insert" on public.tax_rule_sets
  for insert with check (public.is_manager(restaurant_id));

create policy "tax_calculations: member read" on public.tax_calculations
  for select using (public.is_member(restaurant_id));
create policy "tax_calculations: manager insert" on public.tax_calculations
  for insert with check (public.is_manager(restaurant_id));

-- Seed both demo restaurants with two versions: v1 (H1 2026) and v2 (rate
-- change from 2026-07-01). Pricing a document today selects v2; the version
-- picker in the trace shows why.
insert into public.tax_rule_sets
  (restaurant_id, version, name, effective_from, effective_to, rounding_mode, rules)
select r.id, v.version, v.name, v.effective_from::date, v.effective_to::date, v.rounding_mode, v.rules::jsonb
from public.restaurants r
cross join (values
  (1, 'EU VAT 2026 H1', '2026-01-01', '2026-06-30', 'half_up',
   '[{"kind":"vat","name":"Standard VAT","rate_bps":2100,"applies_to":"default"},
     {"kind":"vat","name":"Reduced VAT","rate_bps":900,"applies_to":"categories","categories":["Produce","Dairy"]},
     {"kind":"withholding","name":"Vendor withholding","rate_bps":200,"threshold_minor":100000}]'),
  (2, 'EU VAT 2026 H2', '2026-07-01', null, 'half_up',
   '[{"kind":"vat","name":"Standard VAT","rate_bps":2200,"applies_to":"default"},
     {"kind":"vat","name":"Reduced VAT","rate_bps":900,"applies_to":"categories","categories":["Produce","Dairy"]},
     {"kind":"withholding","name":"Vendor withholding","rate_bps":200,"threshold_minor":100000}]')
) as v(version, name, effective_from, effective_to, rounding_mode, rules)
on conflict (restaurant_id, version) do nothing;
