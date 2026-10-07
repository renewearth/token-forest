import { connectDb, closeDb, Member, MemberIdentity, UsageDaily, Device, ModelPrice } from "@/lib/db";
import { todayKst, addDays } from "@/lib/date";
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:27391\/tf-v2-test-ax-20261003$/.test(uri)) throw new Error("Only the isolated AX fixture database is allowed.");
async function main() {
 await connectDb();
 const people = [
  { id: "660000000000000000000001", name: "실험 작성자", email: "ax-a@example.test" },
  { id: "660000000000000000000002", name: "적용 동료", email: "ax-b@example.test" },
  { id: "660000000000000000000003", name: "미참여 구성원", email: "ax-c@example.test" },
 ];
 for(const p of people) {
  await Member.updateOne({_id:new Types.ObjectId(p.id)},{$set:{name:p.name,email:p.email,toolPrefs:["claude_code"],onboardedAt:new Date(),hidden:false}},{upsert:true});
  await MemberIdentity.updateOne({memberId:new Types.ObjectId(p.id),tool:"claude_code",externalId:p.email},{$set:{memberId:new Types.ObjectId(p.id),tool:"claude_code",externalId:p.email}},{upsert:true});
 }
 const today=todayKst();
 for (const [index,p] of people.slice(0,2).entries()) {
  for(const dayOffset of [0,2,3,5]) {
   const day=addDays(today,-dayOffset);
   const key={date:day,tool:"claude_code",model:"ax-fixture",externalId:p.email,machineId:"ax-fixture",source:"manual"};
   await UsageDaily.updateOne(key,{$set:{...key,memberId:new Types.ObjectId(p.id),inputTokens:100*(index+1),outputTokens:20*(dayOffset+1),cacheReadTokens:dayOffset===2?null:80,cacheCreationTokens:10,requests:(index+1)*(dayOffset+1),sessions:1}},{upsert:true});
  }
 }
 await Device.updateOne({externalId:people[0].email,machineId:"ax-preview-device"},{$set:{externalId:people[0].email,machineId:"ax-preview-device",label:"테스트 기기",lastSeenAt:new Date(),uploaderVersion:"test",health:[],healthHistory:[]}},{upsert:true});
 await ModelPrice.updateOne({family:"ax-fixture",provider:"",effectiveFrom:"2020-01-01"},{$set:{family:"ax-fixture",provider:"",match:["=ax-fixture"],priority:100,effectiveFrom:"2020-01-01",input:1,output:2,cacheRead:0.1,cacheWrite:1.25,sourceUrl:"https://example.test/prices",checkedAt:"2026-10-03",note:"Synthetic test price",registeredBy:"AX fixture"}},{upsert:true});
 console.log("Synthetic AX preview: 3 members, 8 usage rows, day gaps and missing fields, no credentials.");
}
main().finally(closeDb);
