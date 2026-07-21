export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Restaurant {
  id: string;
  name: string;
  region: "EU" | "US";
  created_at: string;
}

export interface Profile {
  id: string;
  full_name: string | null;
  email: string | null;
}

export interface RestaurantMember {
  user_id: string;
  restaurant_id: string;
  role: "manager" | "staff";
}

export interface Category {
  id: string;
  restaurant_id: string;
  name: string;
  icon: string | null;
}

export interface Product {
  id: string;
  restaurant_id: string;
  category_id: string | null;
  name: string;
  unit: string;
  volume: number | null;
  volume_unit: string | null;
  min_quantity: number;
  current_stock: number | null;
  is_active: boolean;
  created_at: string;
  categories?: Pick<Category, "name" | "icon"> | null;
}

export interface Subscription {
  id: string;
  restaurant_id: string;
  stripe_subscription_id: string;
  status:
    | "incomplete"
    | "incomplete_expired"
    | "trialing"
    | "active"
    | "past_due"
    | "canceled"
    | "unpaid"
    | "paused";
  price_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}

export interface Entitlement {
  restaurant_id: string;
  feature: string;
  active: boolean;
  source: string | null;
  updated_at: string;
}

export interface PurchaseOrder {
  id: string;
  restaurant_id: string;
  po_number: string;
  supplier_name: string;
  status: "draft" | "approved" | "cancelled";
  currency: string;
  subtotal_minor: number;
  tax_total_minor: number;
  withholding_minor: number;
  total_minor: number;
  tax_calculation_id: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  xero_invoice_id: string | null;
  pdf_generated_at: string | null;
  created_at: string;
  updated_at: string;
  profiles?: Pick<Profile, "full_name"> | null;
}

export interface PurchaseOrderLine {
  id: string;
  purchase_order_id: string;
  description: string;
  category_name: string | null;
  quantity: number;
  unit: string | null;
  unit_price_minor: number;
  line_subtotal_minor: number;
  tax_minor: number;
  line_total_minor: number;
  tax_detail: { rule_name: string; rate_bps: number } | null;
}

export interface AuditEvent {
  id: string;
  restaurant_id: string;
  actor_id: string | null;
  actor_type: "user" | "system" | "stripe" | "xero" | "otp" | "outbox";
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: Record<string, Json>;
  created_at: string;
}

export interface OutboxEvent {
  id: string;
  restaurant_id: string;
  event_type: string;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface XeroSyncLogEntry {
  id: string;
  operation: "oauth_connect" | "token_refresh" | "invoice_push" | "bill_import";
  direction: "push" | "pull" | "auth";
  status: "success" | "error";
  xero_id: string | null;
  summary: Record<string, Json>;
  error: string | null;
  created_at: string;
}

export interface XeroBill {
  id: string;
  xero_invoice_id: string;
  contact_name: string | null;
  xero_status: string | null;
  date: string | null;
  due_date: string | null;
  total: number | null;
  currency: string | null;
  imported_at: string;
}

export interface PurchaseRequest {
  id: string;
  restaurant_id: string;
  product_id: string;
  created_by: string | null;
  quantity: number;
  priority: "urgent" | "normal" | "whenever" | "by_breakfast" | "by_lunch" | "by_dinner";
  status: "pending" | "bought" | "not_found" | "partial" | "cancelled";
  created_at: string;
  products?: Pick<Product, "name" | "unit"> | null;
  profiles?: Pick<Profile, "full_name"> | null;
}
