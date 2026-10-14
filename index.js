import pkg from '@slack/bolt'; // imports slack framework
const {App} = pkg; //creates slack app instance
import {WebClient} from '@slack/web-api'; //import slack web client 
import {ChatGroq} from '@langchain/groq'; //langchain wrapper for Groq's OpenAI-compatible chat API
import{ChatPromptTemplate} from '@langchain/core/prompts'; // prompt template for structured prompts with variable 
import express from 'express';//help checks and testing endpoints
import dotenv from 'dotenv';
import axios from 'axios';//help in making external api requests
import {pathToFileURL} from 'url';//used to tell whether this file was run directly

import {initDatabase, saveMemberAnalysis,markAsSentToSlack,closeDatabase,findRecentAnalysis,getLastDedupeError} from './db.js'

// override:true makes .env the source of truth. Without it dotenv only fills in
// variables that are NOT already set, so a stale OS-level OPENAI_API_KEY would
// silently shadow the real key in this file. On Render there is no .env, so the
// dashboard's environment variables still apply as normal.
dotenv.config({ override: true });//reads .env file

//log utility object with 3 log levels ( to log info,error,debugging messages)
const log = {
    info: (msg, ...args) =>console.log(`[INFO] ${msg}`, ...args),
    error: (msg, ...args) =>console.log(`[ERROR] ${msg}`, ...args),
    debug: (msg, ...args) =>process.env.NODE_ENV === "development" && console.log(`[DEBUG] ${msg}`, ...args) // only  print log output of debug when if the node environment is set to development
}

// when we make the main application class that encapsulates the slackbot express server and AI logic

class SlackAIAgent {
    //initialize all services and wireup event handlers
    constructor (){
        this.app = express ()//creates app instance for the HTTP server 

        // creates Slack bolt app instance using socket mode , so no public URL needed here
        this.slack = new App({
            token: process.env.SLACK_BOT_TOKEN,
            signingSecret: process.env.SLACK_SIGNING_SECRET,
            socketMode: true, //uses websocket connection instead of HTTP
            appToken: process.env.SLACK_APP_TOKEN
        });
        //Creates Standalone Slack web client for direct API calls outside of Bolt event system
        this.webClient = new WebClient(process.env.SLACK_BOT_TOKEN);
         // Groq serves open models on its own inference hardware through an
         // OpenAI-compatible API. Model is configurable so it can be changed
         // without touching code - see console.groq.com/docs/models.
         this.llmProvider = 'groq';
         this.llmModel = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
         this.llm = new ChatGroq({
            model: this.llmModel,
            temperature: 0.3,
            apiKey: process.env.GROQ_API_KEY
         });
         // Members currently being analyzed. team_join and member_joined_channel can fire
         // for the same person at almost the same moment, so the database check alone is not
         // enough - the first analysis may not be saved yet when the second event arrives.
         this.inFlightMembers = new Set();
         // How far back a previous analysis counts as "already done" (default 30 days)
         this.dedupeWindowHours = parseInt(process.env.DEDUPE_WINDOW_HOURS || '720', 10);

         //Registering Slack event Listener
         this.setupSlackEvents();
         this.setupExpress();
    } 
    //user joins the team
    setupSlackEvents() {
        this.slack.event('team_join', async ({event}) => {
            try {
                log.info(`New member joined: ${event.user.real_name || event.user.name}`)
                // fetching the full user profile from the slack api
                const userInfo = await this.getUserInfo(event.user.id);
                if (this.shouldSkipUser(userInfo)) return;
                await this.analyzeAndPostMember(userInfo);

            } catch (error) {
                log.error('Error processing team_join:', error.message)
            }
        });
        //user joins the channel
        this.slack.event('member_joined_channel',async({event}) =>{
            try{
                if(event.channel_type ==='C'){
                    log.info(`Member ${event.user} joined channel ${event.channel}`)
                    const userInfo = await this.getUserInfo(event.user);
                    if (this.shouldSkipUser(userInfo)) return;
                    await this.analyzeAndPostMember(userInfo)
                }

            }catch (error){
                log.error('Error processing member_joined_channel:', error.message)
            }
        });
        this.slack.error(async(error) => log.error('Slack error:', error.message))
    }

    setupExpress() {
        this.app.use(express.json());
        this.app.get('/health',(req,res) => {
            res.json({
                status:'healthy',
                llmProvider: this.llmProvider,
                llmModel: this.llmModel,
                timestamp: new Date().toISOString()
            });            
        })

        if (process.env.NODE_ENV === 'development'){
                this.app.post('/test/analyze-member',async(req,res) => {
                    try{
                        const{ memberInfo}=req.body;
                        if(!memberInfo) return res.status(400).json({error:'memberInfo is required'})
                        // force:true lets us re-test the same member without the dedupe check skipping it
                        const result = await this.analyzeAndPostMember(memberInfo, { force: req.body.force === true });
                        if (result && result.skipped){
                            return res.json({
                                success: true,
                                skipped: true,
                                reason: result.reason,
                                existingAnalysisId: result.existingAnalysisId || null,
                                timestamp: new Date().toISOString()
                            });
                        }
                        res.json({
                            success: true,
                            analysis: result ? result.analysis : null,
                            analysisId: result ? result.analysisId : null,
                            dedupeLookupError: getLastDedupeError(),
                            timestamp: new Date().toISOString()
                        });

                    }catch(error){
                        log.error('Test analysis error:', error.message)
                        res.status(500).json({error: 'Analysis failed',message: error.message})
                    }
                });
            }

            this.app.use((err, req, res, next) =>{
                log.error('Express error', err.message)
                res.status(500).json({error:'Internal server error'})

            })            
    }
    // Fetching detailed user information from the Slack API
    async getUserInfo(userId){
        const result = await this.webClient.users.info({user: userId});
        const user = result.user;
        //returning a normalized user info object with only the fields needed
        return {
            id: user.id,
            isBot: user.is_bot === true,
            isDeleted: user.deleted === true,
            name: user.real_name || user.name,
            username: user.name,
            email: user.profile?.email,
            title: user.profile?.title,
            timezone: user.tz,
            profile: {
                firstName: user.profile?.first_name,
                lastName: user.profile?.last_name,
                statusText: user.profile?.status_text
            }
        } ;

    }

    // A member only needs analyzing once: skip Slackbot, other bots and deactivated accounts.
    shouldSkipUser(memberInfo){
        if (!memberInfo || !memberInfo.id) return false;
        if (memberInfo.isBot || memberInfo.id === 'USLACKBOT'){
            log.info(`Skipping bot user ${memberInfo.name || memberInfo.id}`);
            return true;
        }
        if (memberInfo.isDeleted){
            log.info(`Skipping deactivated user ${memberInfo.name || memberInfo.id}`);
            return true;
        }
        return false;
    }

    // Key we dedupe on: the Slack user id when we have one, otherwise the lowercased name
    dedupeKey(memberInfo){
        return memberInfo.id ? `id:${memberInfo.id}` : `name:${(memberInfo.name || '').toLowerCase()}`;
    }

    //main analysis pipeline that researches a member,runs AI analysis, saves this to a database and post to slack
    async analyzeAndPostMember(memberInfo, options = {}){
        let analysisId = null;
        const key = this.dedupeKey(memberInfo);

        // Guard 1 (in-memory): another event for this same person is being processed right now
        if (!options.force && this.inFlightMembers.has(key)){
            log.info(`Skipping ${memberInfo.name}: analysis already in progress`);
            return { skipped: true, reason: 'analysis_in_progress' };
        }
        this.inFlightMembers.add(key);

        try{
            // Guard 2 (database): we already analyzed this person inside the dedupe window
            if (!options.force){
                const existing = await findRecentAnalysis(memberInfo.id, memberInfo.name, this.dedupeWindowHours);
                if (existing){
                    log.info(`Skipping ${memberInfo.name}: already analyzed (id ${existing.id}) at ${existing.analyzedAt}`);
                    return { skipped: true, reason: 'already_analyzed', existingAnalysisId: existing.id };
                }
            }

            log.info(`Processing member: ${memberInfo.name}`)
            const researchData = await this.doBasicResearch(memberInfo);
            const analysis = await this.analyzeWithAI(memberInfo, researchData);
            //persisting the analysis to the database before posting to ensure no data loss
            log.info(`Saving analysis to database for ${memberInfo.name}`);
            analysisId = await saveMemberAnalysis(memberInfo,analysis, researchData);
            //post the formatted analysis to the private slack channel
            await this.postAnalysisToChannel(memberInfo,analysis, researchData);
            if (analysisId){
                await markAsSentToSlack(analysisId);
            }
            return { skipped: false, analysisId, analysis };
        }catch(error){
            log.error(`Error processing ${memberInfo.name}:`, error.message);
            if(analysisId){
                log.info(`Analysis ${analysisId} saved to database but not sent to slack due to error`);
            }
            throw error;
        } finally {
            this.inFlightMembers.delete(key);
        }
    }

    async doBasicResearch(memberInfo){
        const results =[];
        try{
            if(memberInfo.email && !this.isPersonalEmail(memberInfo.email)){
                const domain = memberInfo.email.split('@')[1];
                const companyInfo = await this.getCompanyInfo(domain);
                if (companyInfo) results.push(companyInfo);
                if (memberInfo.name){
                    const githubInfo = await this.getGithubInfo(memberInfo.name);
                    if (githubInfo) results.push(githubInfo);

                }
            }

        }catch(error){
            log.error('Research error:',error.message);
        }
        return results;
    }

    async getCompanyInfo(domain){
        try{
            const response = await axios.get(`https://www.${domain}`,{
                timeout: 5000,
                headers: {'User-Agent': 'Mozilla/5.0'}

            });
            //using reject to extract the title tag content from the html
            const titleMatch = response.data.match(/<title>(.*?)<\/title>/i)
            //search for any title tag, putting a fallback to just the domain name if no title tag is found.
            const title = titleMatch ? titleMatch[1] : `Company: ${domain}`;

            return {
                url: `https://www.${domain}`,
                title: title,
                content:`Company website for ${domain}`,
                type:'company'
            }

        } catch(error){
            log.error(`Could not fetch ${domain}:`, error.message);
            return null;
        }
    }
    //Searches Github API for user profile matching the member's name 
    async getGithubInfo(name){
        try{
            const response = await axios.get(
                `https://api.github.com/search/users?q=${encodeURIComponent(name)}`,
                {
                    timeout: 5000
                }
            );
            if (response.data.items && response.data.items.length > 0){
                const user = response.data.items[0];
                return{
                    url: user.html_url,
                    title:`GitHub: ${user.login}`,
                    content: `${user.public_repos} public repositories`,
                    type:'github'
                }
            } 
            
        }catch(error){
            log.debug('GitHub search error:', error.message)
        }
        return null;

    }
    // Models like to wrap JSON in a ```json ... ``` markdown fence. Strip the fence, and if the
    // response still is not clean JSON, fall back to the outermost {...} block in the text.
    parseAnalysisJSON(responseText){
        const text = String(responseText || '').trim();
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        const candidate = (fenced ? fenced[1] : text).trim();
        try{
            return JSON.parse(candidate);
        } catch (error){
            const braced = candidate.match(/\{[\s\S]*\}/);
            if (braced){
                return JSON.parse(braced[0]);
            }
            throw new Error(`Could not parse JSON from model response: ${candidate.slice(0, 200)}`);
        }
    }

    //Analyze with AI function which uses GPT4 via langchain to analyze a member's fit with the company's products
    async analyzeWithAI(memberInfo, researchData){
        const prompt = ChatPromptTemplate.fromTemplate(
            `Analyze this new community member for fit with our commercial 
    product.

    Company: ${process.env.COMPANY_NAME || 'Your Company'}
    Product: ${process.env.COMPANY_PRODUCT || 'Your Product'}

    Member:
    - Name: {name}
    - Email: {email}
    - Title: {title}

    Research Data:
    {research}
    Provide a JSON response with:
    - fitScore (0-100): likelihood they'd be interested in our product
    - insights: array of 3-5 key observations
    - recommendations: array of 2-4 engagement suggestions

    Consider job title, company size, technical background, and budget 
    authority.`

        );

        try{
            const researchSummary = researchData.length>0
            ? researchData.map(r => `${r.title}: ${r.content}`).join('\n')
            :'limited research data available'

            // json_object mode makes the model return syntactically valid JSON.
            // parseAnalysisJSON below stays as a safety net for anything unexpected.
            const chain = prompt.pipe(
                // withConfig, not bind - bind was removed in LangChain v1.
                this.llm.withConfig({ response_format: { type: 'json_object' } })
            );
            const result = await chain.invoke({
                name: memberInfo.name,
                email: memberInfo.email || 'Not provided',
                title: memberInfo.title || 'Not provided',
                research: researchSummary
            });

            const responseText = typeof result === 'string' ? result : (result?.content ?? '');
            const analysis = this.parseAnalysisJSON(responseText);
            return{
                fitScore:Math.max(0, Math.min(100, analysis.fitScore || 50)),
                insights: Array.isArray(analysis.insights) ? analysis.insights : ['Analysis completed'],
                recommendations: Array.isArray(analysis.recommendations)? analysis.recommendations:['Follow up recommended']
            }

        }catch(error){
            log.error('AI analysis error:', error.message);
            return{
                fitScore:50,
                insights: ['Unable to complete full analysis'],
                recommendations: ['Manual review recommended'],
                // Not persisted - just surfaced by the dev test endpoint so the real
                // failure is visible instead of hiding behind a default score of 50
                aiError: error.message
            }
        }
    }

    async postAnalysisToChannel(member,analysis,researchData){
        const color = analysis.fitScore >= 80 ? '#36a64f'
            : analysis.fitScore >=60 ? '#ffb84d'
                : analysis.fitScore >= 40 ? '#ff9500' : '#ff4444';

        const blocks = [
            {
                type: 'header',
                text: { type: 'plain_text', text:`🔍 New Member: ${member.name}`}
            },
            {
                type: 'section',
                fields: [
                    {type: 'mrkdwn',text:  `*Fit Score:* ${analysis.fitScore}/100`},
                    {type: 'mrkdwn', text: `*Email:* ${member.email || 'Not provided'}` },
                    {type: 'mrkdwn', text: `*Title:* ${member.title || 'Not provided'}` },
                ]
            }
        ];

        if (analysis.insights.length > 0){
            blocks.push({
                type:'section',
                text:{
                    type:'mrkdwn',
                    text:`*Insights:*\n${analysis.insights.map(i =>
                        `• ${i}`).join('\n')}`
                    
                }
            })
        }

        if (analysis.recommendations.length > 0){
            blocks.push({
                type:'section',
                text:{
                    type:'mrkdwn',
                    text:`*Recommendations:*\n${analysis.recommendations.map(i =>
                        `• ${i}`).join('\n')}`                    
                }
            })
        }

        blocks.push({
            type:'context',
            elements:[
                {
                    type:'mrkdwn',
                    text: `📊Analyzed: ${new Date().toISOString()}`
                }
            ]
        });

        await this.webClient.chat.postMessage({
            channel: process.env.SLACK_PRIVATE_CHANNEL_ID,
            text: `New Member Analysis: ${member.name} (${analysis.fitScore}/100)`,
            blocks
        });

        log.info(`Analysis posted to channel for ${member.name}`)
    }

    isPersonalEmail(email){
        const personalDomains = ['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com'];
        const domain = email.split('@')[1]?.toLowerCase();
        return personalDomains.includes(domain);
    }
    // function to start all services 
    async start(){
        try{
            log.info('Initiaizing database...')
            await initDatabase()

            const port = process.env.PORT || 3000;
            this.server = this.app.listen(port,() =>{
                log.info(`🚀 Express server running on port ${port}`);
            })

            await this.slack.start();
            log.info('⚡Slack bot connected');

            log.info(`🤖 LLM: ${this.llmProvider} / ${this.llmModel}`)
            log.info('🎉Slack AI Agent is running!')

            if (process.env.NODE_ENV ==='development'){
                log.info(`Test endpoint: POST http://localhost:${port}/test/analyze-member`)
            }


        }catch(error){
            log.error('Failed to start:',error.message)
            process.exit(1)
        }
    }

    // function to shut down  all services 
    async stop(){
        try{
            await this.slack.stop()
            if(this.server){
                await new Promise(resolve => this.server.close(resolve));
            }

            //closing postgresql connection
            await closeDatabase();
            log.info('Stopped Successfully')

        }catch(error){
            log.error('Shutdown error:',error.message)
        }
        process.exit(0)
    }
}

// instantiate the Agent
const agent = new SlackAIAgent()

// Only wire up signals and start the services when this file is run directly
// (node index.js / npm start). Importing it from a test leaves the agent idle.
const isEntryPoint = process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint){
    // LISTEN TO CTRL C TO SHUT DOWN
    process.on('SIGINT', () => agent.stop());
    //LISTEN FOR TERMINATION SIGNALS FROM DOCKER OR RENDER TO SHUT DOWN
    process.on('SIGTERM', () => agent.stop());
    //START THE AGENT
    agent.start().catch(error =>{
        console.error('Startup Failed:',error.message);
        process.exit(1)
    })
}

export default agent
export { SlackAIAgent }