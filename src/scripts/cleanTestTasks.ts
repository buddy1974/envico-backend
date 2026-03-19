import prisma from '../db/prisma';

async function clean() {
  const { count } = await prisma.task.deleteMany({
    where: { title: { startsWith: 'TEST —' } },
  });
  console.log(`Deleted ${count} test task(s).`);
  await prisma.$disconnect();
}

clean().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
