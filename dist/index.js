"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = __importDefault(require("axios"));
const dotenv = __importStar(require("dotenv"));
const fs = __importStar(require("fs/promises"));
const set_interval_async_1 = require("set-interval-async");
// Load environment variables
dotenv.config();
// Configuration
const X_API_V2_BASE_URL = "https://api.twitter.com/2";
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || "";
const LAST_ID_FILE = "./last_id.txt";
const POLL_INTERVAL_MS = 30 * 1000;
const X_BOT_BACKEND_URL = process.env.X_BOT_BACKEND_URL || "";
const LOGGED_USER_ID = "1654404334736777216";
// Function to load the last ID from the file
function loadLastId() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const id = yield fs.readFile(LAST_ID_FILE, "utf8");
            return id.trim() || null;
        }
        catch (_a) {
            return null;
        }
    });
}
// Function to save the latest tweet ID to last_id.txt
function saveLastId(id) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!/^[0-9]+$/.test(id)) {
            console.warn("Skipping save: invalid tweet ID:", id);
            return;
        }
        try {
            yield fs.writeFile(LAST_ID_FILE, id);
            console.log(`Saved tweet ID ${id} to last_id.txt`);
        }
        catch (error) {
            console.error("Error saving last ID:", error);
        }
    });
}
function waitForRateLimitReset(resetTime_1) {
    return __awaiter(this, arguments, void 0, function* (resetTime, attempt = 1) {
        const now = Math.floor(Date.now() / 1000);
        const delay = Math.max((resetTime - now) * 1000, 0) + attempt * 1000;
        console.log(`Rate limit hit. Waiting ${delay / 1000} seconds...`);
        return new Promise((resolve) => setTimeout(resolve, delay));
    });
}
function getUserId(accountHandle) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const cleanHandle = accountHandle.startsWith("@") ? accountHandle.slice(1) : accountHandle;
            const response = yield axios_1.default.get(`${X_API_V2_BASE_URL}/users/by/username/${cleanHandle}`, {
                headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
            });
            return response.data.data.id;
        }
        catch (error) {
            console.error("Error fetching user ID:", error.message);
            return null;
        }
    });
}
function shouldReplyToTweet(tweet, targetUserId, targetHandle) {
    if (tweet.author_id === targetUserId || tweet.author_id === LOGGED_USER_ID)
        return false;
    const mentionsTarget = tweet.text.toLowerCase().includes(`@${targetHandle.toLowerCase()}`);
    const isReplyToTarget = tweet.in_reply_to_user_id === targetUserId;
    return mentionsTarget || isReplyToTarget;
}
// Fetch tweets in real-time
function fetchRecentTweets(query, sinceId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        try {
            const params = {
                query,
                "tweet.fields": "created_at,in_reply_to_user_id",
                "user.fields": "username,name",
                max_results: 100,
                expansions: "author_id",
            };
            if (sinceId && !isNaN(Number(sinceId))) {
                params.since_id = sinceId;
            }
            const response = yield axios_1.default.get(`${X_API_V2_BASE_URL}/tweets/search/recent`, {
                params,
                headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
            });
            const data = response.data;
            const rateLimit = {
                remaining: parseInt(response.headers["x-rate-limit-remaining"] || "0"),
                reset: parseInt(response.headers["x-rate-limit-reset"] || "0"),
            };
            const users = (((_a = data.includes) === null || _a === void 0 ? void 0 : _a.users) || []).reduce((acc, user) => {
                acc[user.id] = { username: user.username, name: user.name };
                return acc;
            }, {});
            return { tweets: data.data || [], users, rateLimit };
        }
        catch (error) {
            console.error("Error fetching recent tweets:", error.message);
            return { tweets: [], users: {}, rateLimit: null };
        }
    });
}
function replyWithLoggedUser(tweetId) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const url = `${X_BOT_BACKEND_URL}/reply`;
            const response = yield axios_1.default.post(url, {
                loggedUserId: LOGGED_USER_ID,
                replyToTweetId: tweetId,
                useAI: true,
                customPrompt: "Please answer the user's question directly without mentioning the user or tagging them.",
                text: "", // Empty text for a direct reply without mention
            });
            console.log(`✅ Reply sent to tweet ${tweetId}`);
        }
        catch (error) {
            console.error(`❌ Failed to reply to tweet ${tweetId}:`, error.message);
        }
    });
}
function monitorXData(accountHandle) {
    return __awaiter(this, void 0, void 0, function* () {
        const cleanHandle = accountHandle.startsWith("@") ? accountHandle.slice(1) : accountHandle;
        const encodedQuery = `@${cleanHandle}`;
        let lastId = yield loadLastId();
        const userId = yield getUserId(cleanHandle);
        console.log("userId: ", userId);
        if (!userId) {
            console.error("Failed to get user ID. Exiting.");
            return;
        }
        console.log("Fetching initial tweets...");
        const { tweets, users } = yield fetchRecentTweets(encodedQuery, lastId);
        if (tweets.length > 0) {
            lastId = tweets[0].id;
            yield saveLastId(lastId);
        }
        else {
            console.log("No tweets found, continuing to listen...");
        }
        for (const tweet of tweets) {
            const user = users[tweet.author_id];
            const isReply = tweet.in_reply_to_user_id === userId;
            console.log(`[${tweet.created_at}] @${user.username}${isReply ? " (reply)" : ""}: ${tweet.text}`);
            if (shouldReplyToTweet(tweet, userId, cleanHandle)) {
                console.log(`🤖 Auto-replying to tweet from @${user.username}`);
                yield replyWithLoggedUser(tweet.id); // Now replying directly without mentioning
            }
        }
        console.log("Starting fallback polling...");
        const poll = () => __awaiter(this, void 0, void 0, function* () {
            try {
                const { tweets, users, rateLimit } = yield fetchRecentTweets(encodedQuery, lastId);
                if (tweets.length > 0) {
                    for (const tweet of tweets) {
                        const user = users[tweet.author_id];
                        const isReply = tweet.in_reply_to_user_id === userId;
                        console.log(`[${tweet.created_at}] @${user.username}${isReply ? " (reply)" : ""}: ${tweet.text}`);
                        if (shouldReplyToTweet(tweet, userId, cleanHandle)) {
                            console.log(`🤖 Auto-replying to tweet from @${user.username}`);
                            yield replyWithLoggedUser(tweet.id); // Now replying directly without mentioning
                        }
                        if (!lastId || BigInt(tweet.id) > BigInt(lastId)) {
                            lastId = tweet.id;
                            yield saveLastId(lastId);
                        }
                    }
                }
                if (rateLimit) {
                    console.log(`Rate limit: ${rateLimit.remaining} remaining, resets at ${new Date(rateLimit.reset * 1000)}`);
                }
            }
            catch (error) {
                console.error("Polling error:", error.message);
            }
        });
        yield poll();
        (0, set_interval_async_1.setIntervalAsync)(poll, POLL_INTERVAL_MS);
    });
}
const targetAccount = "@liora_ai";
monitorXData(targetAccount).catch((error) => console.error("Fatal error:", error));
