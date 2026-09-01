import pg from 'pg';
const {Pool} = pg;
import dotenv from 'dotenv';

dotenv.config({ override: true });// .env wins over any stale OS-level variables
// creating pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false},
    //maximum number of members in the pool
    max:20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
});
// event listener that fires each time a new client connects to the database 
pool.on('connect',() => {
    console.log('[INFO] Database connected');
});
// event listener that fires unexpected errors from idle clients in the pool 
pool.on('error',(err) => {
    console.error('[ERROR] Unexpected database error:',err.message);
});
// function that creates database table and indexes if they don't already exist
export async function initDatabase(){
    // Acquiring client from the pool for running multiple queries in sequence
    const client = await pool.connect();
    try{
        //member analysis table if one does not already exists
        await client.query(`
        CREATE TABLE IF NOT EXISTS member_analyses (
            id SERIAL PRIMARY KEY,
            member_id VARCHAR(255),
            member_name VARCHAR(255) NOT NULL,
            member_email VARCHAR(255),
            member_title VARCHAR(255),
            member_timezone VARCHAR(100),
            fit_score INTEGER NOT NULL,
            insights JSONB,
            recommendations JSONB,
            research_data JSONB,
            analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            sent_to_slack BOOLEAN DEFAULT FALSE,
            sent_to_slack_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
            
        `)
        //create index on member ID for the last lookups by the Slack User ID 

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_member_id ON member_analyses(member_id);
            `);

        //Create index on analyze at for efficient time range queries 
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_analyzed_at ON member_analyses(analyzed_at);
            `)
        
            console.log('[INFO] Database schema initialized');

    }catch (error){
        console.log('[ERROR] Failed to initialize database:',error.message);
        throw error;
    } finally {
        client.release()
    }
}
// function to save member analysis
export async function saveMemberAnalysis(memberInfo,analysis,researchData){
    const client = await pool.connect();
    try{
//Inserting analysis data  using parameterized queries to prevent SQL  injection 
        const result = await client.query(
            `INSERT INTO member_analyses (
            member_id, 
            member_name, 
            member_email, 
            member_title, 
            member_timezone,
            fit_score, 
            insights, 
            recommendations, 
            research_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id`,
            [
                memberInfo.id || null,
                memberInfo.name,
                memberInfo.email || null,
                memberInfo.title || null,
                memberInfo.timezone || null,
                analysis.fitScore,
                JSON.stringify(analysis.insights),
                JSON.stringify(analysis.recommendations),
                JSON.stringify(researchData)
            ]);
        // logging new ID
        console.log(`[INFO] Saved Analysis to Database with ID: ${result.rows[0].id}`);
        return result.rows[0].id;        
    } catch(error){
        console.error('[ERROR] Failed to save analysis to database:',error.message);
        throw error;
    }finally{
        client.release();
    }
}
// Records why the most recent dedupe lookup failed, so /test/analyze-member can show it.
// The lookup itself still fails open - we would rather analyze twice than not at all.
let lastDedupeError = null;
export function getLastDedupeError(){ return lastDedupeError; }

// Function to look up a recent analysis for a member so we don't analyze the same
// person over and over (team_join and member_joined_channel can both fire for one person).
// Matches on Slack user id when we have one, otherwise falls back to the member name.
export async function findRecentAnalysis(memberId, memberName, windowHours = 720){
    const client = await pool.connect();
    try{
        const result = await client.query(
            `SELECT id, member_name, fit_score, analyzed_at
             FROM member_analyses
             WHERE (
                    ($1::varchar IS NOT NULL AND member_id = $1)
                 OR ($1::varchar IS NULL AND $2::varchar IS NOT NULL AND LOWER(member_name) = LOWER($2))
             )
               AND analyzed_at > NOW() - make_interval(hours => $3::int)
             ORDER BY analyzed_at DESC
             LIMIT 1`,
            [memberId || null, memberName || null, windowHours]
        );
        lastDedupeError = null;
        return result.rows[0] || null;
    } catch (error){
        lastDedupeError = error.message;
        console.error('[ERROR] Failed to check for existing analysis:', error.message);
        // Fail open: if the dedupe lookup breaks we would rather analyze twice than not at all
        return null;
    } finally {
        client.release();
    }
}

// Function to mark as sent to slack (update the record to indicate the analysiss has been successfully sent to slack )
export async function markAsSentToSlack(analysisId){
    const client = await pool.connect();
    try{
        await client.query(
             `UPDATE member_analyses
         SET sent_to_slack = TRUE,
            sent_to_slack_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`, [analysisId]
        );
    } catch (error){
        console.error('[ERROR] Failed to mark as sent to Slack:', error.message);
        throw error;
    } finally{
        client.release()
    }
}

export async function closeDatabase(){
    await pool.end();
    console.log('[INFO] Database connection pool closed');
}

export default pool;