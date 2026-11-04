export function grandstandLayout(config) {
  const front = config.grandstandFront;
  const lowerInner = front + config.plinthDepth * 0.35;
  const lowerOuter = lowerInner + config.lowerTierDepth;
  const lowerBackY = config.lowerTierRise;
  const concourseTop = lowerBackY + config.concourseHeight * 0.7;
  const upperInner = lowerOuter + config.concourseDepth * 0.22;
  const upperFrontY = concourseTop + config.upperTierStep;
  const upperBackY = upperFrontY + config.upperTierRise;
  const upperOuter = upperInner + config.upperTierDepth;
  return {
    front,
    lowerInner,
    lowerOuter,
    lowerBackY,
    concourseTop,
    upperInner,
    upperFrontY,
    upperBackY,
    upperOuter,
  };
}
