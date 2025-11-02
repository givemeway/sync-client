import { prisma, Prisma } from "./Config/prismaDBConfig.js";

// await prisma.directory.create({
//   data: {
//     uuid: "some-dir-uuid1",
//     device: "device-1234",
//     folder: "docs2",
//     created_at: new Date(),
//     path: "/user/docs",
//   },
// });

// await prisma.file.create({
//   data: {
//     path: "/user/docs",
//     filename: "file2.txt",
//     last_modified: new Date(),
//     hashvalue: "abcd1234",
//     enc_hashvalue: "some random enc hash",
//     iv: "some-iv",
//     salt: "some-salt",
//     dirID: "some-dir-uuid1",
//     size: 100,
//   },
// });

const files = await prisma.file.findMany({});
console.log("Files:", files);

const directory = await prisma.directory.findMany({});

console.log(directory);
