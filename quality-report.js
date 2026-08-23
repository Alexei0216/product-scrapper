function isAutoSku(sku) {
  return /^AUTO(?:-V)?-/.test(String(sku || ""));
}

function inspectProduct(product) {
  const warnings = [];
  if (!product.name) warnings.push("missing_name");
  if (product.price === "" || product.price === undefined) warnings.push("missing_price");
  if (!product.images?.length) warnings.push("missing_images");
  if (isAutoSku(product.sku)) warnings.push("generated_parent_sku");
  if ((product.variants || []).some((variant) => isAutoSku(variant.sku))) warnings.push("generated_variant_sku");

  return {
    sourceUrl: product.sourceUrl,
    name: product.name,
    confidence: product.confidence,
    images: product.images?.length || 0,
    variants: product.variants?.length || 0,
    customOptions: product.customOptions?.length || 0,
    warnings,
  };
}

function createQualityReport(products, failed = []) {
  const items = products.map(inspectProduct);
  const warningCount = items.filter((item) => item.warnings.length).length;
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      products: items.length,
      productsWithWarnings: warningCount,
      productsWithVariants: items.filter((item) => item.variants).length,
      productsWithCustomOptions: items.filter((item) => item.customOptions).length,
      failedPages: failed.length,
    },
    products: items,
    failedPages: failed,
  };
}

module.exports = { createQualityReport, inspectProduct };
