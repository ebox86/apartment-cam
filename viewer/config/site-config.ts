export type SiteConfig = {
  siteTitle: string;
  siteSubtitle: string;
  siteTitlePrefix: string;
  siteTitleLocationFallback: string;
  locationLabel: string;
  headerText: string;
  headerDescription: string;
  streamAltText: string;
  defaultCountryCode: string;
};

export const siteConfig: SiteConfig = {
  siteTitle: "APARTMENT-CAM",
  siteSubtitle: "Real-time cam viewer · PTZ, telemetry & weather",
  siteTitlePrefix: "APARTMENT-CAM // ",
  siteTitleLocationFallback: "Pittsburgh, PA",
  locationLabel: "Pittsburgh, Pennsylvania, USA",
  headerText: "Alcoa bldg 30th floor",
  headerDescription:
    "Watch the skyline from 30 stories up with live telemetry & overview data.",
  streamAltText: "Pittsburgh skyline live camera",
  defaultCountryCode: "US",
};
