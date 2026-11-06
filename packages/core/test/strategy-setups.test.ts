import { describe, expect, it } from "vitest";
import { meetsRewardRisk, researchSetup, strategyKindForTemplate, templateConfig, validateStrategyConfig, type Bar } from "../src";

const bars = (closes: number[]): Bar[] => closes.map((c, i) => ({ t:i*14400, o:c, h:c+1, l:c-1, c, v:1 }));

describe("research strategy setups", () => {
  it("accepts reward-risk ratios at the threshold despite floating-point rounding", () => {
    expect(meetsRewardRisk(1.99999999999999, 2)).toBe(true);
    expect(meetsRewardRisk(1.999, 2)).toBe(false);
    expect(meetsRewardRisk(NaN, 2)).toBe(false);
  });
  it("detects a breakout against the prior channel, without including the current bar", () => {
    const input = bars([...Array(24).fill(100), 103]);
    expect(researchSetup("breakout", input)).toMatchObject({ available:true, entry:true, exit:false, observations:{previousHigh:101} });
    expect(researchSetup("breakout", bars([...Array(24).fill(100), 100])).entry).toBe(false);
    expect(researchSetup("breakout", bars([...Array(24).fill(100), 97])).exit).toBe(true);
  });
  it("requires an actual recovery through the lower volatility band", () => {
    const setup = researchSetup("bollinger", bars([...Array(23).fill(100), 80, 92]));
    expect(setup).toMatchObject({ available:true, entry:true, exit:false });
    expect(researchSetup("bollinger", bars([...Array(23).fill(100), 80, 79])).entry).toBe(false);
  });
  it("requires RSI to cross out of oversold, not merely stay oversold", () => {
    const declining = Array.from({length:24}, (_,i) => 100-i);
    expect(researchSetup("rsi-recovery", bars([...declining, 87]))).toMatchObject({ available:true, entry:true });
    expect(researchSetup("rsi-recovery", bars([...declining, 75])).entry).toBe(false);
  });
  it("does not create signals from insufficient or invalid data", () => {
    expect(researchSetup("breakout", bars([100, 101]))).toMatchObject({ available:false, entry:false, exit:false });
    const input = bars(Array(25).fill(100)); input[2].c = NaN;
    expect(researchSetup("bollinger", input).available).toBe(false);
  });
  it.each([["spot-breakout","breakout"],["spot-bollinger","bollinger"],["spot-rsi-recovery","rsi-recovery"]] as const)("validates and maps %s without changing old definitions", (template, expected) => {
    expect(validateStrategyConfig(templateConfig(template)).template).toBe(template);
    expect(strategyKindForTemplate(template)).toBe(expected);
  });
});
