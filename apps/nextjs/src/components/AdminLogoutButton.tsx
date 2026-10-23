"use client";

import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Signs the staff member out (admin/profile/logout). */
export default function AdminLogoutButton() {
  const router = useRouter();
  async function logout() {
    try {
      await fbPost("admin", "profile", "logout");
    } catch {
      // Session may already be gone; leave anyway.
    }
    router.push("/admin/login");
    router.refresh();
  }
  return (
    <button onClick={logout} className="underline hover:text-white">
      Sign out
    </button>
  );
}
