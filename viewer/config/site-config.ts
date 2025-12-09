export type SiteConfig = {
  siteTitle: string;
  siteSubtitle: string;
  siteTitlePrefix: string;
  siteTitleLocationFallback: string;
  locationLabel: string;
  headerText: string;
  streamAltText: string;
  defaultCountryCode: string;
};

export const siteConfig: SiteConfig = {
  siteTitle: "APARTMENT-CAM",
  siteSubtitle: "Real-time MJPEG viewer · PTZ, telemetry & weather",
  siteTitlePrefix: "APARTMENT-CAM // ",
  siteTitleLocationFallback: "Pittsburgh, PA",
  locationLabel: "Pittsburgh, Pennsylvania, USA",
  headerText: "AXIS P3227-LVE Network Camera",
  streamAltText: "Pittsburgh skyline live camera",
  defaultCountryCode: "US",
};
