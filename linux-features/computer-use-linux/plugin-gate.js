"use strict";

function applyLinuxComputerUsePluginGatePatch(currentSource) {
  const fail = () => {
    throw new Error(
      "Required Linux Computer Use plugin gate patch failed: expected one current native registration",
    );
  };
  const identifier = String.raw`[A-Za-z_$][\w$]*`;
  const reference = String.raw`${identifier}(?:\.${identifier})+`;
  const descriptorPattern = new RegExp(
    String.raw`\{\.\.\.(${reference}\.computerUse),autoInstallOptOutKey:\(0,(${reference})\)\(\1\.name\),` +
      String.raw`isAvailable:\(\{features:(${identifier}),platform:(${identifier})\}\)=>` +
      String.raw`\("darwin"===\4\|\|"win32"===\4(?<linux>\|\|"linux"===\4)?\)&&\3\.computerUse\}`,
    "g",
  );
  const descriptors = [...currentSource.matchAll(descriptorPattern)];
  const spreadCount = [
    ...currentSource.matchAll(new RegExp(String.raw`\{\.\.\.${reference}\.computerUse,`, "g")),
  ].length;
  if (descriptors.length !== 1 || spreadCount !== 1) fail();

  const descriptor = descriptors[0];
  if (descriptor.groups.linux != null) return currentSource;
  const [match, metadata, optOut, features, platform] = descriptor;
  const replacement =
    `{...${metadata},autoInstallOptOutKey:(0,${optOut})(${metadata}.name),` +
    `isAvailable:({features:${features},platform:${platform}})=>` +
    `("darwin"===${platform}||"win32"===${platform}||"linux"===${platform})&&` +
    `${features}.computerUse}`;
  return currentSource.slice(0, descriptor.index) + replacement +
    currentSource.slice(descriptor.index + match.length);
}

module.exports = { applyLinuxComputerUsePluginGatePatch };
