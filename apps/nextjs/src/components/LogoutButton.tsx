"use client";

import { useRouter } from "next/navigation";
import { fbPost } from "@/lib/browser";

/** Signs the client out of the PHP session (client/profile/logout). */
export default function LogoutButton() {
  const router = useRouter();
  async function logout() {
    try {
      await fbPost("client", "profile", "logout");
    } catch {
      // Even if the call fails, leave the area; the session may already be gone.
    }
    router.push("/login");
    router.refresh();
  }
  return (
    <button onClick={logout} className="text-zinc-600 underline hover:text-zinc-900">
      Sign out
    </button>
  );
}
