import { Router } from "express";
import jwt from "jsonwebtoken";
import { env, isSlackConfigured } from "../config/env";
import { prisma } from "../db/prisma";
import { requireAuth } from "../middleware/auth";
import { notifyRateLimitReached } from "../services/slack";

const router = Router();

const SLACK_SCOPES = "incoming-webhook";

interface SlackStatePayload {
  userId: string;
  purpose: "slack-oauth";
}

// State is a signed token rather than a random value compared against a cookie.
// It carries the user id, expires in ten minutes, and cannot be forged without
// JWT_SECRET, so the callback needs no session and works regardless of which
// host Slack was told to redirect to.
function signState(userId: string): string {
  return jwt.sign(
    { userId, purpose: "slack-oauth" } satisfies SlackStatePayload,
    env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

function verifyState(state: string): string | null {
  try {
    const payload = jwt.verify(state, env.JWT_SECRET) as SlackStatePayload;
    if (payload.purpose !== "slack-oauth") return null;
    return payload.userId;
  } catch {
    return null;
  }
}

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  team?: { id: string; name: string };
  incoming_webhook?: {
    url: string;
    channel: string;
    channel_id: string;
    configuration_url: string;
  };
}

router.get("/connect", requireAuth, (req, res) => {
  if (!isSlackConfigured) {
    res.status(503).json({ error: "Slack is not configured on this server" });
    return;
  }

  const state = signState(req.user!.id);

  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", env.SLACK_CLIENT_ID!);
  url.searchParams.set("scope", SLACK_SCOPES);
  url.searchParams.set("redirect_uri", env.SLACK_REDIRECT_URI!);
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

router.get("/callback", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;

    if (req.query.error) {
      res.redirect(`${env.FRONTEND_URL}/dashboard?slack=denied`);
      return;
    }

    const userId = state ? verifyState(state) : null;
    if (!code || !userId) {
      res.redirect(`${env.FRONTEND_URL}/dashboard?slack=invalid_state`);
      return;
    }

    const body = new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID!,
      client_secret: env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: env.SLACK_REDIRECT_URI!,
    });

    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await response.json()) as SlackOAuthResponse;

    if (!data.ok || !data.incoming_webhook?.url) {
      console.error("[slack] oauth exchange failed:", data.error);
      res.redirect(`${env.FRONTEND_URL}/dashboard?slack=failed`);
      return;
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        slackWebhook: data.incoming_webhook.url,
        slackTeamName: data.team?.name ?? null,
        slackChannel: data.incoming_webhook.channel,
      },
    });

    res.redirect(`${env.FRONTEND_URL}/dashboard?slack=connected`);
  } catch (err) {
    next(err);
  }
});

router.post("/disconnect", requireAuth, async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { slackWebhook: null, slackTeamName: null, slackChannel: null },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/test", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: { slackWebhook: true },
    });

    const result = await notifyRateLimitReached({
      webhookUrl: user.slackWebhook,
      senderId: `test-${Date.now()}`,
      senderEmail: "test@ethereal.email",
      scope: "sender",
      resumesAt: new Date(Date.now() + 3600000),
    });

    res.json({ result });
  } catch (err) {
    next(err);
  }
});

export default router;
