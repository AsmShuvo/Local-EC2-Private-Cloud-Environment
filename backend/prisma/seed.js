const prisma = require('../config/prisma');

const PLACEHOLDER_USERS = [
  { email: 'ada.lovelace@example.com', name: 'Ada Lovelace' },
  { email: 'alan.turing@example.com', name: 'Alan Turing' },
  { email: 'grace.hopper@example.com', name: 'Grace Hopper' },
  { email: 'linus.torvalds@example.com', name: 'Linus Torvalds' },
];

async function main() {
  console.log('Seeding placeholder users...');
  for (const u of PLACEHOLDER_USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name },
      create: u,
    });
    console.log(`  ${u.email}`);
  }
  const total = await prisma.user.count();
  console.log(`Done. Total users: ${total}`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
