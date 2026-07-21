"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ACTIVE_RESTAURANT_COOKIE,
  requireRestaurantContext,
} from "@/lib/current-restaurant";

export async function switchRestaurant(formData: FormData) {
  const restaurantId = formData.get("restaurant_id");
  const context = await requireRestaurantContext();
  if (
    typeof restaurantId !== "string" ||
    !context.memberships.some((membership) => membership.id === restaurantId)
  ) {
    throw new Error("Restaurant selection is invalid.");
  }

  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_RESTAURANT_COOKIE, restaurantId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  redirect("/dashboard");
}
