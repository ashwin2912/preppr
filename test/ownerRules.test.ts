import { describe, expect, it } from "vitest";
import { ruleOwner } from "../src/domain/ownerRules";

describe("owner chat rules (strict)", () => {
  it.each([
    ["today dal, paneer, roti", { action: "set_menu", day: "today", dishes: "dal, paneer, roti", cutoff: null }],
    ["Today: 1 3 5", { action: "set_menu", day: "today", dishes: "1 3 5", cutoff: null }],
    ["tomorrow's menu - dal and roti cutoff 11am", { action: "set_menu", day: "tomorrow", dishes: "dal and roti", cutoff: "11am" }],
    ["tmrw dal (16oz), roti", { action: "set_menu", day: "tomorrow", dishes: "dal (16oz), roti", cutoff: null }],
    ["Tue: chole, rice by 10.30", { action: "set_menu", day: "tue", dishes: "chole, rice", cutoff: "10:30" }],
    ["same", { action: "copy_menu", from: null }],
    ["Same as yesterday", { action: "copy_menu", from: "yesterday" }],
    ["same as last time please", { action: "copy_menu", from: null }],
    ["same as last monday", { action: "copy_menu", from: "monday" }],
    ["same menu as Tue", { action: "copy_menu", from: "tue" }],
    ["cutoff 11", { action: "set_cutoff", cutoff: "11" }],
    ["Cut-off is 10:30am", { action: "set_cutoff", cutoff: "10:30am" }],
    ["set the cutoff to 10.45", { action: "set_cutoff", cutoff: "10:45" }],
    ["help", { action: "help" }],
    ["Hi", { action: "help" }],
    ["ok thanks", { action: "ack" }],
    ["👍", { action: "ack" }],
  ])("%s", (text, want) => expect(ruleOwner(text)).toEqual(want));

  it.each([
    "same as yesterday but no rice",
    "same but add kheer",
    "today no rice",
    "today dal, remove roti",
    "today what's on?",
    "today dal 6, roti 1",
    "today dal $6",
    "dal 16oz is 11 now",
    "add samosa",
    "cutoff",
    "cutoff tomorrow 11",
    "remove kheer from my dishes",
    "today",
    "okay so today dal and roti",
    "",
  ])("leaves %s to the model", (text) => expect(ruleOwner(text)).toBeNull());
});
