// Jest helpers to mock HTTP wrapper calls used by integrations
import * as http from "../../../src/services/http";

export function mockHttpGetJsonOnce<T = unknown>(data: T) {
	return jest.spyOn(http, "httpGetJson").mockResolvedValueOnce(data);
}

export function mockHttpGetJsonRejectOnce(error: unknown) {
  return jest.spyOn(http, "httpGetJson").mockRejectedValueOnce(error);
}

export function mockHttpPostJsonOnce<TRes = unknown>(data: TRes) {
	return jest.spyOn(http, "httpPostJson").mockResolvedValueOnce(data);
}

export function mockHttpPostJsonRejectOnce(error: unknown) {
  return jest.spyOn(http, "httpPostJson").mockRejectedValueOnce(error);
}

export function restoreHttpMocks() {
  jest.restoreAllMocks();
}
