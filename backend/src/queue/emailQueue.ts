import { Queue } from "bullmq";
import { connection } from "./connection";

export const EMAIL_QUEUE_NAME = "emails";

export interface EmailJobData {
  emailId: string;
}

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: false,
  },
});

export async function closeQueue(): Promise<void> {
  await emailQueue.close();
}
