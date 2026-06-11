import pkg from '@slack/bolt'; // imports slack framework
const {App} = pkg; //creates slack app instance
import {WebClient} from '@slack/web-api'; //import slack web client 
import {ChatOpenAI} from '@langchain/openai'; //import langchain openai wrapper which provides interface of open ai chat models
import{ChatPromptTemplate} from '@langchain/core/prompts'; // prompt template for structured prompts with variable 
import express from 'express';//help checks and testing endpoints
import dotenv from 'dotenv';
import axios from 'axios';//help in making external api requests

dotenv.config();//reads .env file

//log utility object with 3 log levels ( to log info,error,debugging messages)
const log = {
    info: (msg, ...args) =>console.log('[INFO] ${msg}', ...args),
    error: (msg, ...args) =>console.log('[ERROR] ${msg}', ...args),
    debug: (msg, ...args) =>process.env.NODE_ENV === "development" && console.log('[DEBUG] ${msg}', ...args) // only  print log output of debug when if the node environment is set to development
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
        this.webClient = new webClient(process.env.SLACK_BOT_TOKEN)
    } 
}