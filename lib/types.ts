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
