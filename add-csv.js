const fs = require("fs");

const csvDefaults = {
  category: "Suspencion > Copelas regulables",
  productBrand: "PMC Motorsport",
  carBrand: "VAG",
};

function addPriceMarkup(price, markup) {
  const value = Number(
    String(price || "")
      .replace(/\./g, "")
      .replace(",", ".") 
  );

  if (!Number.isFinite(value)) return price || "";

  return (value + markup).toFixed(2).replace(".", ",");
}

function toCSV(products) {
  const header = [
    "Type",
    "Published",
    "In stock?",
    "Visibility in catalog",
    "Name",
    "Regular price",
    "SKU",
    "Categories",
    "Description",
    "Images",
    "taxonomy=product_brand",
    "taxonomy=car_brand"
  ];

  const rows = products.map(p => [
    "simple",
    "1",
    "1",
    "visible",
    p.name,
    addPriceMarkup(p.price, 25),
    p.sku,
    csvDefaults.category,
    p.description,
    Array.isArray(p.images) ? p.images.join(", ") : "",
    csvDefaults.productBrand,
    csvDefaults.carBrand
  ]);

  const csv = [header, ...rows]
    .map(row =>
      row
        .map(v => `"${(v || "").replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  fs.writeFileSync("products.csv", csv);

  console.log("✔ CSV saved: products.csv");
}

module.exports = toCSV;
