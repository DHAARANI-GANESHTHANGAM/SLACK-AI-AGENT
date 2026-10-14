import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config({ override: true });// .env wins over any stale OS-level variables

// All analyses live in one collection. Mongo creates it on first insert,
// so "initializing the schema" here really means making sure the indexes exist.
const COLLECTION = 'member_analyses';

let client = null;
let database = null;

// The client is built lazily rather than at import time, so importing this file
// (from a test, for example) never needs MONGODB_URI to be set.
function getClient(){
    if (!client){
        const uri = process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGODB_URI is not set in .env');
        client = new MongoClient(uri, {
            maxPoolSize: 20,
            serverSelectionTimeoutMS: 10000
        });
    }
    return client;
}

// Connects once and reuses the same connection for every later call.
// The driver pools connections internally, so this is the equivalent of the old pg Pool.
async function getDb(){
    if (database) return database;
    await getClient().connect();
    database = getClient().db(process.env.MONGODB_DB || 'slack_ai_agent');
    console.log('[INFO] Database connected');
    return database;
}

// Creates the indexes the queries below rely on. Safe to run on every startup -
// createIndex is a no-op when the index already exists.
export async function initDatabase(){
    try{
        const db = await getDb();
        const col = db.collection(COLLECTION);
        // fast dedupe lookups by Slack user id
        await col.createIndex({ memberId: 1, analyzedAt: -1 });
        // fast dedupe lookups by name, for members with no Slack id (e.g. the test endpoint)
        await col.createIndex({ memberNameLower: 1, analyzedAt: -1 });
        // efficient time-range queries
        await col.createIndex({ analyzedAt: -1 });
        console.log('[INFO] Database schema initialized');
    } catch (error){
        console.log('[ERROR] Failed to initialize database:', error.message);
        throw error;
    }
}

// Saves one member analysis and returns its id as a string.
// Unlike Postgres this stores insights/recommendations/research as real nested
// documents, so no JSON.stringify round-trip is needed.
export async function saveMemberAnalysis(memberInfo, analysis, researchData){
    try{
        const db = await getDb();
        const now = new Date();
        const result = await db.collection(COLLECTION).insertOne({
            memberId: memberInfo.id || null,
            memberName: memberInfo.name,
            // stored lowercased so the name-based dedupe lookup can use an index
            memberNameLower: (memberInfo.name || '').toLowerCase(),
            memberEmail: memberInfo.email || null,
            memberTitle: memberInfo.title || null,
            memberTimezone: memberInfo.timezone || null,
            fitScore: analysis.fitScore,
            insights: analysis.insights,
            recommendations: analysis.recommendations,
            researchData: researchData,
            analyzedAt: now,
            sentToSlack: false,
            sentToSlackAt: null,
            createdAt: now,
            updatedAt: now
        });
        const id = result.insertedId.toString();
        console.log(`[INFO] Saved Analysis to Database with ID: ${id}`);
        return id;
    } catch (error){
        console.error('[ERROR] Failed to save analysis to database:', error.message);
        throw error;
    }
}

// Marks an analysis as delivered to Slack.
export async function markAsSentToSlack(analysisId){
    try{
        const db = await getDb();
        await db.collection(COLLECTION).updateOne(
            { _id: new ObjectId(analysisId) },
            { $set: { sentToSlack: true, sentToSlackAt: new Date(), updatedAt: new Date() } }
        );
    } catch (error){
        console.error('[ERROR] Failed to mark as sent to Slack:', error.message);
        throw error;
    }
}

// Records why the most recent dedupe lookup failed, so /test/analyze-member can show it.
// The lookup itself still fails open - we would rather analyze twice than not at all.
let lastDedupeError = null;
export function getLastDedupeError(){ return lastDedupeError; }

// Looks up a recent analysis for a member so we don't analyze the same person over
// and over (team_join and member_joined_channel can both fire for one person).
// Matches on Slack user id when we have one, otherwise falls back to the member name.
export async function findRecentAnalysis(memberId, memberName, windowHours = 720){
    try{
        if (!memberId && !memberName) return null;
        const db = await getDb();
        const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
        const match = memberId
            ? { memberId: memberId }
            : { memberNameLower: memberName.toLowerCase() };

        const doc = await db.collection(COLLECTION).findOne(
            { ...match, analyzedAt: { $gt: cutoff } },
            { sort: { analyzedAt: -1 } }
        );

        lastDedupeError = null;
        if (!doc) return null;
        // Returned in a flat shape so callers don't have to know about _id
        return {
            id: doc._id.toString(),
            memberName: doc.memberName,
            fitScore: doc.fitScore,
            analyzedAt: doc.analyzedAt
        };
    } catch (error){
        lastDedupeError = error.message;
        console.error('[ERROR] Failed to check for existing analysis:', error.message);
        // Fail open: if the dedupe lookup breaks we would rather analyze twice than not at all
        return null;
    }
}

export async function closeDatabase(){
    if (client){
        await client.close();
        client = null;
        database = null;
    }
    console.log('[INFO] Database connection pool closed');
}
//end