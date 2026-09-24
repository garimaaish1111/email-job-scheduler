"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authUrls } from "@/lib/api";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";

const OAUTH_ERRORS: Record<string, string> = {
  access_denied: "You cancelled the Google sign in.",
  invalid_state: "Sign in expired. Please try again.",
  no_id_token: "Google did not return an identity token.",
  incomplete_profile: "Google did not share an email address.",
};

function LoginContent() {
  const router = useRouter();
  const params = useSearchParams();
  const { user, loading } = useAuth();
  const { toast } = useToast();
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    const err = params.get("error");
    if (err) toast("error", OAUTH_ERRORS[err] ?? "Sign in failed.");
  }, [params, toast]);

  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  if (loading || user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white text-ink-faint">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="w-full max-w-[408px] rounded-xl border border-line p-10 shadow-sm">
        <h1 className="mb-7 text-center text-[32px] font-bold text-ink">Login</h1>

        <Button
          variant="soft"
          fullWidth
          size="md"
          loading={redirecting}
          className="!rounded-lg h-12"
          onClick={() => {
            setRedirecting(true);
            window.location.href = authUrls.googleLogin;
          }}
        >
          <GoogleMark />
          Login with Google
        </Button>

        <div className="my-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          <span className="text-xs text-ink-faint">or sign up through email</span>
          <span className="h-px flex-1 bg-line" />
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            toast("info", "Email sign in is not enabled. Use Login with Google.");
          }}
        >
          <Input name="email" type="email" placeholder="Email ID" autoComplete="off" />
          <Input name="password" type="password" placeholder="Password" autoComplete="off" />
          <Button type="submit" fullWidth className="mt-3 !rounded-lg h-12">
            Login
          </Button>
        </form>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-white text-ink-faint">
          <Spinner size={24} />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5h-1.9V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5h-1.9V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.2 5.2C36.9 40.2 44 35 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
  );
}
