import {prisma} from "../Config/prismaDBConfig.js"

export const updateSyncQueue = async ()=>{
    await prisma.file.insert({
    data:{

    }
  })

}
