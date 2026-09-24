import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import { attachUser } from "./middleware/auth";
import { ensureIndex } from "./services/search";
import { bullBoardRouter, BULL_BOARD_PATH } from "./queue/bullBoard";
import authRoutes from "./routes/auth.routes";
import campaignRoutes from "./routes/campaign.routes";
import emailRoutes from "./routes/email.routes";
import slackRoutes from "./routes/slack.routes";

const app = express();

// credentials: true is required for the session cookie to cross the port
// boundary, and must be paired with credentials: "include" on the frontend.
// The origin cannot be "*" once credentials are enabled.
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(attachUser);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "email-scheduler-api", env: env.NODE_ENV });
});

app.use(BULL_BOARD_PATH, bullBoardRouter);
app.use("/api/auth", authRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/emails", emailRoutes);
app.use("/api/slack", slackRoutes);

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("[error]", err);
    res.status(500).json({ error: err.message ?? "Internal server error" });
  }
);

async function start(): Promise<void> {
  await ensureIndex();

  app.listen(env.PORT, () => {
    console.log(`API listening on http://localhost:${env.PORT}`);
    console.log(`Queue dashboard at http://localhost:${env.PORT}${BULL_BOARD_PATH}`);
  });
}

void start();
