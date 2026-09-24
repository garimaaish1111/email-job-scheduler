import { Router } from "express";
import { randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env";
import { prisma } from "../db/prisma";
import { AUTH_COOKIE, requireAuth, signToken } from "../middleware/auth";

const router = Router();

const STATE_COOKIE = "oauth_state";

const oauthClient = new OAuth2Client({
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  redirectUri: env.GOOGLE_CALLBACK_URL,
});

router.get("/google", (_req, res) => {
  const state = randomBytes(16).toString("hex");

  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    maxAge: 10 * 60 * 1000,
  });

  const url = oauthClient.generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });

  res.redirect(url);
});

router.get("/google/callback", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const expectedState = req.cookies?.[STATE_COOKIE];

    res.clearCookie(STATE_COOKIE);

    if (req.query.error) {
      res.redirect(`${env.FRONTEND_URL}/?error=access_denied`);
      return;
    }
    if (!code || !state || state !== expectedState) {
      res.redirect(`${env.FRONTEND_URL}/?error=invalid_state`);
      return;
    }

    const { tokens } = await oauthClient.getToken(code);
    if (!tokens.id_token) {
      res.redirect(`${env.FRONTEND_URL}/?error=no_id_token`);
      return;
    }

    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload?.sub || !payload.email) {
      res.redirect(`${env.FRONTEND_URL}/?error=incomplete_profile`);
      return;
    }

    const user = await prisma.user.upsert({
      where: { googleId: payload.sub },
      update: {
        email: payload.email,
        name: payload.name ?? payload.email,
        avatarUrl: payload.picture ?? null,
      },
      create: {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name ?? payload.email,
        avatarUrl: payload.picture ?? null,
      },
    });

    res.cookie(AUTH_COOKIE, signToken(user.id), {
      httpOnly: true,
      sameSite: "lax",
      secure: env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.redirect(`${env.FRONTEND_URL}/dashboard`);
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        slackTeamName: true,
        slackChannel: true,
        slackWebhook: true,
      },
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        slackConnected: Boolean(user.slackWebhook),
        slackTeamName: user.slackTeamName,
        slackChannel: user.slackChannel,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.json({ ok: true });
});

export default router;
