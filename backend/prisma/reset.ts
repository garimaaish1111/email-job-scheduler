import { prisma } from "../src/db/prisma";
import { emailQueue } from "../src/queue/emailQueue";
import { connection } from "../src/queue/connection";
import { esClient, EMAIL_INDEX } from "../src/services/search";

async function main() {
  await emailQueue.obliterate({ force: true });
  console.log("queue obliterated");

  const emails = await prisma.email.deleteMany({});
  const campaigns = await prisma.campaign.deleteMany({});
  console.log(`deleted ${emails.count} emails, ${campaigns.count} campaigns`);

  const keys = await connection.keys("ratelimit:*");
  const notified = await connection.keys("slack:notified:*");
  const slots = await connection.keys("sendslot:*");
  const all = [...keys, ...notified, ...slots];
  if (all.length) await connection.del(...all);
  console.log(`cleared ${all.length} redis counters`);

  try {
    await esClient.deleteByQuery({
      index: EMAIL_INDEX,
      query: { match_all: {} },
      refresh: true,
    });
    console.log("elasticsearch index cleared");
  } catch {
    console.log("elasticsearch unavailable, skipped");
  }

  const senders = await prisma.sender.count();
  const users = await prisma.user.count();
  console.log(`kept ${senders} senders and ${users} users`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await connection.quit();
  });
