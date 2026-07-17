-- Placeholder: run per restaurant after creation.
-- Example usage:
--   select seed_default_categories('<restaurant_id>');

create or replace function public.seed_default_categories(p_restaurant_id uuid)
returns void language plpgsql as $$
begin
  -- populated in a later migration or application logic
end;
$$;
