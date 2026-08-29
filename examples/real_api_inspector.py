from mlbricks_builder import Builder

builder = Builder(preset="tinystories")
print(builder.component_api("esa"))
print(builder.component_api("ffn"))
builder
