const packArgument = process.argv.find((argument) => argument.startsWith("--pack="));

if (!packArgument) {
  console.error("Usage: npm run pack:bootstrap -- --pack=<pack-id>");
  process.exitCode = 2;
} else {
  const packId = packArgument.slice("--pack=".length);
  console.error(`Pack compiler foundation is not available yet for ${packId}; complete Gate 1 first.`);
  process.exitCode = 1;
}
