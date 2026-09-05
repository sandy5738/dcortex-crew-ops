"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
// Store DB in the node folder
const dbPath = path_1.default.resolve(__dirname, '../airline.db');
function getDb() {
    // better-sqlite3 is fully synchronous and very fast!
    return new better_sqlite3_1.default(dbPath);
}
