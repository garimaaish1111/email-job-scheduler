import { prisma } from "../src/db/prisma";
import { SENDERS } from "../src/config/env";

async function main() {
  for (const s of SENDERS) {
    const sender = await prisma.sender.upsert({
      where: { email: s.user },
      update: { name: s.name, smtpUser: s.user, smtpPass: s.pass, active: true },
      create: {
        name: s.name,
        email: s.user,
        smtpUser: s.user,
        smtpPass: s.pass,
        active: true,
      },
    });
    console.log(`seeded sender ${sender.email} (${sender.id})`);
  }

  const count = await prisma.sender.count({ where: { active: true } });
  console.log(`${count} active senders in database`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
